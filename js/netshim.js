/**
 * netshim.js – natywne metody java.net / sun.nio.ch zaimplementowane w JS,
 * kierujące ruch na nasz gateway WebSocket↔TCP (serwer /gw).
 *
 * Po co: przeglądarka nie otwiera TCP; CheerpJ udostępnia TCP tylko przez
 * Tailscale, więc własny zestaw natives (cheerpjInit.natives) robi to przez
 * WebSocket do naszego serwera, który dzwoni pod adresem serwera MC.
 *
 * Zakres v1:
 *  - gniazda „proste" (java.net.PlainSocketImpl + SocketInput/Output) – pełne
 *    read/write/close/timeout → WERSJE DO 1.6.x (przed erą Netty/NIO),
 *  - sun.nio.ch (Net/IOUtil/EPoll) – impl. eksperymentalna dla 1.7+ (wymaga
 *    jeszcze testów na podglądzie; selector=NIO to miejsce, w którym porty
 *    pod CheerpJ zwykle się potykają),
 *  - DNS przez endpoint serwera /resolve (przeglądarka nie ma API DNS).
 */

let nextFd = 0x4000;
/** @type {Map<number, any>} */
const table = new Map();

function gwUrl(host, port) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/gw?host=${encodeURIComponent(host)}&port=${port}`;
}

/** Czy ta strona ma w ogóle szansę na gateway (własny serwer vs Pages/statyka)? */
function gatewayLikelyPresent() {
  return !location.hostname.endsWith(".github.io");
}

function fdField(self) {
  try { return self?.fd?.fd | 0; } catch { return -1; }
}
function setFdField(self, fd) {
  try {
    if (self?.fd) self.fd.fd = fd;
    else if (self) self.fd = { fd };
  } catch (e) { console.warn("[net] setFd", e); }
}
async function hostOf(addr) {
  try {
    const h = await addr.getHostAddress?.();
    if (h) return String(h);
  } catch { /* poniżej */ }
  try { if (addr.hostName) return String(addr.hostName); } catch { /* jw */ }
  try { if (addr.holder?.hostName) return String(addr.holder.hostName); } catch { /* jw */ }
  throw new Error("nie udało się odczytać adresu InetAddress");
}
async function jthrow(lib, fqcn, msg) {
  try {
    const parts = fqcn.split(".");
    let cls = lib;
    for (const p of parts) cls = cls?.[p] ?? cls?.[p.charAt(0).toUpperCase() + p.slice(1)];
    cls = await cls;
    const ex = await new cls(msg);
    throw ex;
  } catch (e) {
    if (e instanceof Error && e.message?.includes("is not")) throw new Error(`${fqcn}: ${msg}`);
    throw e;
  }
}

/* ---------------- rdzeń połączenia ---------------- */

function sockEntry(host, port) {
  const entry = {
    kind: "sock", host, port, ws: null,
    rx: [], ended: false, error: null,
    dialWait: null, readWait: null, opts: {},
    boundPort: 0,
  };
  return entry;
}

function attachWs(entry) {
  return new Promise((resolve, reject) => {
    if (!gatewayLikelyPresent()) {
      reject(new Error("Ten hosting nie ma gatewaya TCP – multiplayer działa z własnym serwerem: node server.js"));
      return;
    }
    const ws = new WebSocket(gwUrl(entry.host, entry.port));
    ws.binaryType = "arraybuffer";
    entry.ws = ws;
    let settled = false;
    ws.onopen = () => { /* czekamy na ready/error z kontrolki */ };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        let msg = {};
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === "ready" || msg.t === "dialing") {
          if (msg.t === "ready" && !settled) { settled = true; resolve(); }
        } else if (msg.t === "error") {
          entry.error = msg.code || "GW_ERROR";
          if (!settled) { settled = true; reject(new Error("gateway: " + entry.error)); }
          else { entry.ended = true; wakeRead(entry); }
        } else if (msg.t === "end") {
          entry.ended = true; wakeRead(entry);
          if (!settled) { settled = true; reject(new Error("gateway: zamknięty")); }
        }
        return;
      }
      // binarne = bajty z gry
      const bytes = new Uint8Array(ev.data);
      if (bytes.length) {
        entry.rx.push(bytes);
        wakeRead(entry);
      }
    };
    ws.onerror = () => {
      if (!settled) { settled = true; reject(new Error("WebSocket do gatewaya nie działa")); }
      entry.ended = true; wakeRead(entry);
    };
    ws.onclose = () => { entry.ended = true; wakeRead(entry); };
  });
}

function wakeRead(entry) {
  const w = entry.readWait;
  if (w) { entry.readWait = null; w(); }
}

function rxTotal(entry) {
  let n = 0;
  for (const c of entry.rx) n += c.length;
  return n;
}
function rxCopy(entry, max) {
  const out = new Uint8Array(max);
  let pos = 0;
  while (pos < max && entry.rx.length) {
    const head = entry.rx[0];
    const take = Math.min(head.length, max - pos);
    out.set(head.subarray(0, take), pos);
    pos += take;
    if (take === head.length) entry.rx.shift();
    else entry.rx[0] = head.subarray(take);
  }
  return out.subarray(0, pos);
}

async function readBytes(entry, max, timeoutMs) {
  if (rxTotal(entry) > 0) return rxCopy(entry, max);
  if (entry.ended) return null; // EOF
  await new Promise((resolve, reject) => {
    entry.readWait = resolve;
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (entry.readWait === resolve) { entry.readWait = null; resolve(); }
      }, timeoutMs);
      setTimeout(() => clearTimeout(timer), 0); // timer sprzątany przez resolve poniżej
      const orig = resolve;
      entry.readWait = () => { clearTimeout(timer); orig(); };
    }
  });
  if (rxTotal(entry) > 0) return rxCopy(entry, max);
  if (entry.ended) return null;
  return new Uint8Array(0); // timeout
}

function memView(lib, ptr, len) {
  const v = lib.getJNIDataView();
  return new Uint8Array(v.buffer, Number(ptr), len);
}

/* ---------------- natives: java.net (wersje ≤1.6) ---------------- */

function plainNatives() {
  return {
    Java_java_net_PlainSocketImpl_initProto() {},

    Java_java_net_PlainSocketImpl_socketCreate(_lib, self, isServer) {
      const fd = nextFd++;
      const e = sockEntry(null, 0);
      e.isServer = !!isServer;
      table.set(fd, e);
      setFdField(self, fd);
    },

    async Java_java_net_PlainSocketImpl_socketConnect(_lib, self, address, port, _timeout) {
      const fd = fdField(self);
      const e = table.get(fd);
      if (!e) throw new Error("socket bez fd");
      e.host = await hostOf(address);
      e.port = port | 0;
      e.boundPort = port | 0;
      await attachWs(e);
    },

    Java_java_net_PlainSocketImpl_socketBind() { /* brak realnego bind – ok dla klienta */ },
    Java_java_net_PlainSocketImpl_socketListen() { /* listen tylko dla hostowania – poza zakresem v1 */ },
    async Java_java_net_PlainSocketImpl_socketAccept(_lib, self) {
      await jthrow(_lib, "java.net.SocketException", "hosting serwera z przeglądarki nie jest obsługiwany");
      void self;
    },

    Java_java_net_PlainSocketImpl_socketAvailable(_lib, self) {
      const e = table.get(fdField(self));
      return e ? rxTotal(e) : 0;
    },

    Java_java_net_PlainSocketImpl_socketClose0(_lib, self) {
      const fd = fdField(self);
      const e = table.get(fd);
      if (e) {
        e.ended = true;
        try { e.ws?.close(); } catch { /* jw */ }
        wakeRead(e);
        table.delete(fd);
      }
    },

    Java_java_net_PlainSocketImpl_socketShutdown(_lib, self, how) {
      const e = table.get(fdField(self));
      if (!e) return;
      if (how === 0) { e.ended = true; wakeRead(e); } // SHUT_RD
      if (how === 1 && e.ws) { try { e.ws.close(); } catch { /* jw */ } }
    },

    Java_java_net_PlainSocketImpl_socketSetOption0(_lib, self, cmd, on, value) {
      const e = table.get(fdField(self));
      if (e) e.opts[cmd] = { on, value };
    },
    Java_java_net_PlainSocketImpl_socketGetOption(_lib, self, opt) {
      const e = table.get(fdField(self));
      if (opt === 4 /* SO_REUSEADDR */) return e?.isServer ? 1 : 0;
      if (opt === 129 /* SO_RCVBUF */ || opt === 128 /* SO_SNDBUF */) return 65536;
      if (opt === 1 /* SO_KEEPALIVE?? */) return 0;
      return e?.opts[opt]?.on ? 1 : 0;
    },
    Java_java_net_PlainSocketImpl_socketSendUrgentData() { /* brak OOB */ },

    Java_java_net_SocketInputStream_init() {},
    Java_java_net_SocketOutputStream_init() {},

    async Java_java_net_SocketInputStream_socketRead0(_lib, self, _fdObj, b, off, len, timeout) {
      const e = table.get(fdField(self));
      if (!e) throw new Error("read na zamkniętym fd");
      const chunk = await readBytes(e, len | 0, timeout | 0);
      if (chunk === null) return -1;          // EOF
      if (chunk.length === 0) return 0;       // timeout
      b.set(chunk, off | 0);                  // Int8Array by reference
      return chunk.length;
    },
    Java_java_net_SocketOutputStream_socketWrite0(_lib, self, _fdObj, b, off, len) {
      const e = table.get(fdField(self));
      if (!e || !e.ws || e.ws.readyState !== 1) throw new Error("write na zamkniętym fd");
      const slice = b.subarray(off | 0, (off | 0) + (len | 0));
      e.ws.send(slice.slice());
    },
  };
}

/* ---------------- natives: sun.nio.ch (era 1.7+, EKSPERYMENTALNE) ---------------- */

const POLLIN = 1, POLLOUT = 4, POLLERR = 8, POLLHUP = 16, POLLNVAL = 32;

function nioNatives() {
  return {
    Java_sun_nio_ch_Net_initIDs() {},
    Java_sun_nio_ch_Net_isIPv6Available0() { return false; },
    Java_sun_nio_ch_Net_isExclusiveBindAvailable() { return 1; },
    Java_sun_nio_ch_Net_canIPv6SocketJoinIPv4Group0() { return false; },
    Java_sun_nio_ch_Net_canJoin6WithIPv4Group0() { return false; },
    Java_sun_nio_ch_Net_pollinValue() { return POLLIN; },
    Java_sun_nio_ch_Net_polloutValue() { return POLLOUT; },
    Java_sun_nio_ch_Net_pollerrValue() { return POLLERR; },
    Java_sun_nio_ch_Net_pollhupValue() { return POLLHUP; },
    Java_sun_nio_ch_Net_pollnvalValue() { return POLLNVAL; },

    Java_sun_nio_ch_Net_socket0(_lib, _pref, stream, _reuse, _fast) {
      const fd = nextFd++;
      table.set(fd, sockEntry(null, 0));
      table.get(fd).isServer = !stream;
      return fd;
    },
    Java_sun_nio_ch_Net_bind0() { /* client v1 */ },
    Java_sun_nio_ch_Net_listen() { /* hostowanie poza zakresem */ },
    async Java_sun_nio_ch_Net_connect0(_lib, fdObj, remote, remotePort) {
      const fd = fdObj?.fd | 0;
      const e = table.get(fd);
      if (!e) throw new Error("connect0: brak fd");
      e.host = await hostOf(remote);
      e.port = remotePort | 0;
      e.boundPort = e.port;
      await attachWs(e);
      return 0;
    },
    Java_sun_nio_ch_Net_shutdown(_lib, fdObj, how) {
      const e = table.get(fdObj?.fd | 0);
      if (e && how === 0) { e.ended = true; wakeRead(e); }
    },
    Java_sun_nio_ch_Net_localPort(_lib, fdObj) { return table.get(fdObj?.fd | 0)?.boundPort || 0; },
    Java_sun_nio_ch_Net_remotePort(_lib, fdObj) { return table.get(fdObj?.fd | 0)?.port || 0; },
    async Java_sun_nio_ch_Net_localInetAddress(_lib, fdObj) { void fdObj; return await jthrow(_lib, "java.io.IOException", "localAddress niedostępny"); },
    async Java_sun_nio_ch_Net_remoteInetAddress(_lib, fdObj) {
      const e = table.get(fdObj?.fd | 0);
      const cls = await _lib["java.net.InetAddress"];
      return await cls.getByName(e?.host || "127.0.0.1");
    },
    Java_sun_nio_ch_Net_getIntOption0(_lib, _fdObj, _conv, _level, _opt) { return 0; },
    Java_sun_nio_ch_Net_setIntOption0() { /* no-op */ },
    async Java_sun_nio_ch_Net_poll(_lib, fdObj, events, timeout) {
      const e = table.get(fdObj?.fd | 0);
      if (!e) return POLLNVAL;
      const want = events | 0;
      const deadline = Date.now() + Math.max(0, Number(timeout));
      for (;;) {
        let re = 0;
        if (e.kind === "pipe") {
          if (e.rdy && (want & POLLIN)) re |= POLLIN;
        } else {
          if (rxTotal(e) > 0 && (want & POLLIN)) re |= POLLIN;
          if (e.ended && (want & POLLIN)) re |= POLLHUP;
          if (e.ws?.readyState === 1 && (want & POLLOUT)) re |= POLLOUT;
        }
        if (re) return re;
        const left = deadline - Date.now();
        if (left <= 0) return 0;
        await new Promise((r) => setTimeout(r, Math.min(20, left)));
      }
    },

    Java_sun_nio_ch_IOUtil_initIDs() {},
    Java_sun_nio_ch_IOUtil_fdVal(_lib, fdObj) { return fdObj?.fd | 0; },
    Java_sun_nio_ch_IOUtil_setfdVal(_lib, fdObj, v) { try { fdObj.fd = v | 0; } catch { /* jw */ } },
    Java_sun_nio_ch_IOUtil_configureBlocking() { /* cheerpJ i tak blokuje się po swojemu */ },
    Java_sun_nio_ch_IOUtil_fdLimit() { return 4096; },
    Java_sun_nio_ch_IOUtil_iovMax() { return 1024; },
    Java_sun_nio_ch_IOUtil_randomBytes(_lib, arr) {
      const g = crypto.getRandomValues(new Uint8Array(arr.length));
      arr.set(g);
      return true;
    },
    Java_sun_nio_ch_IOUtil_makePipe() {
      const inFd = nextFd++, outFd = nextFd++;
      table.set(inFd, { kind: "pipe", rdy: false });
      table.set(outFd, { kind: "pipe", pair: inFd });
      const long = (BigInt(inFd) << 32n) | BigInt(outFd >>> 0);
      return long;
    },
    Java_sun_nio_ch_IOUtil_drain(_lib, fd) {
      const e = table.get(fd | 0);
      if (e?.kind === "pipe") e.rdy = false;
      return true;
    },
    Java_sun_nio_ch_IOUtil_read(_lib, fd, addr, len, _timeout) {
      const e = table.get(fd | 0);
      if (!e) return -1;
      if (e.kind === "pipe") {
        if (!e.rdy) return 0;
        e.rdy = false;
        return 0;
      }
      if (rxTotal(e) === 0) return e.ended ? -1 : 0;
      const chunk = rxCopy(e, len | 0);
      memView(lib0, addr, chunk.length).set(chunk);
      return chunk.length;
    },
    Java_sun_nio_ch_IOUtil_write(_lib, fd, addr, len) {
      const e = table.get(fd | 0);
      if (e?.kind === "pipe") { const pair = table.get(e.pair); if (pair) pair.rdy = true; return len | 0; }
      if (!e?.ws || e.ws.readyState !== 1) return -1;
      const bytes = memView(lib0, addr, len | 0).slice();
      e.ws.send(bytes);
      return len | 0;
    },

    // --- epoll: minimalna implementacja tabelaryczna (bez realnego epoll) ---
    Java_sun_nio_ch_EPoll_epoll_create(_size) {
      const id = nextFd++;
      table.set(id, { kind: "epoll", reg: new Map() });
      return id;
    },
    Java_sun_nio_ch_EPoll_epoll_ctl(_lib, epfd, op, fd, eventPtr) {
      const ep = table.get(epfd | 0);
      if (!ep || ep.kind !== "epoll") return -1;
      if (op === 2 /* DEL */) { ep.reg.delete(fd | 0); return 0; }
      const v = lib0.getJNIDataView();
      const base = Number(eventPtr);
      const ev = new Uint8Array(4);
      for (let i = 0; i < 4; i++) ev[i] = v.getUint8(base + i);
      const data = new Uint8Array(8);
      for (let i = 0; i < 8; i++) data[i] = v.getUint8(base + 4 + i); // epoll_event packed (x86)
      ep.reg.set(fd | 0, { events: new DataView(ev.buffer).getUint32(0, true), data });
      return 0;
    },
    async Java_sun_nio_ch_EPoll_epoll_wait(_lib, epfd, eventPtr, maxevents, timeout) {
      const ep = table.get(epfd | 0);
      if (!ep || ep.kind !== "epoll") return -1;
      const deadline = Date.now() + Math.max(0, Number(timeout));
      const v = lib0.getJNIDataView();
      for (;;) {
        let n = 0;
        for (const [fd, reg] of ep.reg) {
          if (n >= maxevents) break;
          const e = table.get(fd);
          let re = 0;
          if (!e) re = POLLNVAL;
          else if (e.kind === "pipe") { if (e.rdy) re |= POLLIN; }
          else {
            if (rxTotal(e) > 0 || e.ended) re |= POLLIN;
            if (e.ended) re |= POLLHUP;
            if (e.ws?.readyState === 1) re |= POLLOUT;
          }
          re &= reg.events;
          if (!re) continue;
          const base = Number(eventPtr) + n * 12;
          v.setUint32(base, re >>> 0, true);
          for (let i = 0; i < 8; i++) v.setUint8(base + 4 + i, reg.data[i]);
          n++;
        }
        if (n > 0) return n;
        const left = deadline - Date.now();
        if (left <= 0) return 0;
        await new Promise((r) => setTimeout(r, Math.min(20, left)));
      }
    },
  };
}

/* ---------------- natives: DNS ---------------- */

function inetNatives() {
  const lookup = async (host) => {
    const enc = encodeURIComponent(host);
    // 1) własny serwer (node server.js /resolve)
    try {
      const r = await fetch(`/resolve?host=${enc}`);
      if (r.ok) {
        const j = await r.json();
        if (j.addrs?.length) return j.addrs;
      }
    } catch { /* np. GitHub Pages – dalej DoH z przeglądarki */ }
    // 2) DNS-over-HTTPS z przeglądarki (działa też bez backendu)
    for (const url of [
      `https://dns.google/resolve?name=${enc}&type=A`,
      `https://cloudflare-dns.com/dns-query?name=${enc}&type=A`,
    ]) {
      try {
        const r = await fetch(url, { headers: { accept: "application/dns-json" } });
        if (r.ok) {
          const j = await r.json();
          const addrs = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
          if (addrs.length) return addrs;
        }
      } catch { /* następny resolver */ }
    }
    throw new Error("DNS: nie udało się rozwiązać " + host);
  };
  return {
    Java_java_net_InetAddress_init() {},
    Java_java_net_InetAddress_isIPv6Supported() { return false; },
    Java_java_net_Inet4AddressImpl_lookupAllHostAddr(_lib, host) { return lookup(host); },
    Java_java_net_Inet6AddressImpl_lookupAllHostAddr(_lib, host) { return lookup(host); },
    Java_java_net_InetAddressImpl_lookupAllHostAddr(_lib, host) { return lookup(host); },
  };
}

/** Pełny zestaw do cheerpjInit({ natives: socketNatives() }). */
export function socketNatives() {
  return { ...plainNatives(), ...nioNatives(), ...inetNatives() };
}

// IOUtil.read/write używają widoku pamięci – potrzebna referencja „lib" z ostatniego
// wywołania; natives dostają go jako argument, więc przechwytujemy globalnie.
let lib0 = { getJNIDataView() { throw new Error("lib niegotowy"); } };
for (const [name, fn] of Object.entries({ ...plainNatives(), ...nioNatives(), ...inetNatives() })) {
  void name;
  void fn;
}
// przechwycenie: opakowanie nastąpi w socketNatives()
export function socketNativesWrapped() {
  const raw = socketNatives();
  const out = {};
  for (const [name, fn] of Object.entries(raw)) {
    out[name] = (...args) => {
      if (args[0] && typeof args[0].getJNIDataView === "function") lib0 = args[0];
      return fn(...args);
    };
  }
  return out;
}
