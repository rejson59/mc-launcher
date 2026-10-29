/**
 * server.js – serwer MC Launcher Web:
 *  1) pliki statyczne (MIME, Range z przycinaniem – wymagane dla CheerpJ,
 *     204 zamiast 404 pod ścieżkami gry – reguła z dokumentacji CheerpJ),
 *  2) gateway multiplayer /gw: WebSocket ↔ TCP (protokół Minecrafta),
 *     bo przeglądarka nie potrafi otworzyć gniazda TCP sama.
 *
 * Bez zależności npm. Start: node server.js  (PORT=8080)
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import dns from "node:dns/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.GATEWAY_HOST || "0.0.0.0";
const ALLOW_PRIVATE = process.env.GATEWAY_ALLOW_PRIVATE === "1";
const IDLE_MS = Number(process.env.GATEWAY_IDLE_MS || 300000);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".so": "application/octet-stream",
  ".jar": "application/java-archive",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
};

/* ---------------- statyczne + Range ---------------- */

const SAFE = /^(\/[A-Za-z0-9._\-/% ]*)$/;
const GAME_PREFIXES = ["/app/", "/vendor/", "/lwjgl/", "/data/"];

function send(res, code, headers, body) {
  res.writeHead(code, headers);
  if (body) res.end(body);
  else res.end();
}

function serveFile(req, res, abs, urlPath) {
  fs.stat(abs, (err, st) => {
    if (err || !st.isFile()) {
      // CheerpJ: brak pliku pod ścieżką gry = 204, nie 404 (inaczej wisi na odczycie)
      if (GAME_PREFIXES.some((p) => urlPath.startsWith(p) || urlPath.startsWith(p.slice(1)))) {
        return send(res, 204, { "Cache-Control": "no-cache" });
      }
      return send(res, 404, { "Content-Type": "text/plain" }, "404");
    }
    const size = st.size;
    const mime = MIME[path.extname(abs).toLowerCase()] || "application/octet-stream";
    const base = {
      "Content-Type": mime,
      "Accept-Ranges": "bytes",
      // shell (js/css/html) zawsze świeży – inaczej przeglądarka trzyma stary kod
      "Cache-Control": /\.(html|js|css)$/.test(urlPath) || urlPath === "/" ? "no-cache" : "public, max-age=3600",
    };
    const range = req.headers.range;
    if (range) {
      // CheerpJ pyta np. o bytes=0-131071 pliku 15 KiB – końcówkę TRZEBA przyciąć
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (!m || (!m[1] && !m[2])) {
        return send(res, 416, { "Content-Range": `bytes */${size}` });
      }
      let start, end;
      if (!m[1]) { // suffix: bytes=-N
        const n = Number(m[2]); start = Math.max(0, size - n); end = size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      }
      if (start > end || start >= size) {
        return send(res, 416, { "Content-Range": `bytes */${size}` });
      }
      const len = end - start + 1;
      res.writeHead(206, {
        ...base,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Content-Length": String(len),
      });
      if (req.method === "HEAD") return res.end();
      return fs.createReadStream(abs, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...base, "Content-Length": String(size) });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(abs).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

    // DNS dla gry w przeglądarce (brak API DNS w JS) – netshim to woła
    if (urlPath === "/resolve") {
      const host = new URL(req.url, "http://x").searchParams.get("host") || "";
      if (!/^[A-Za-z0-9._\-:]{1,253}$/.test(host)) {
        return send(res, 400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, JSON.stringify({ addrs: [] }));
      }
      dns.lookup(host, { all: true }).then((rows) => {
        const addrs = rows.map((r) => r.address).filter((a) => net.isIPv4(a));
        const any = addrs.length ? addrs : rows.map((r) => r.address);
        send(res, 200, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": "*",
        }, JSON.stringify({ addrs: any }));
      }).catch(() => {
        send(res, 404, { "Content-Type": "application/json" }, JSON.stringify({ addrs: [] }));
      });
      return;
    }

    if (!SAFE.test(urlPath)) return send(res, 400, {}, "bad path");
    if (urlPath.includes("..")) return send(res, 400, {}, "nope");
    if (urlPath.endsWith("/")) urlPath += "index.html";
    const abs = path.join(ROOT, urlPath);
    if (!abs.startsWith(ROOT)) return send(res, 403, {}, "forbidden");
    serveFile(req, res, abs, urlPath);
  } catch (e) {
    send(res, 500, { "Content-Type": "text/plain" }, "500: " + e.message);
  }
});

/* ---------------- gateway WebSocket ↔ TCP ---------------- */

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function wsHandshake(req, socket) {
  const key = req.headers["sec-websocket-key"];
  if (!key || req.headers.upgrade?.toLowerCase() !== "websocket") {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  return socket;
}

function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  return Buffer.concat([header, payload]);
}

const wsSend = (socket, opcode, payload) => {
  if (!socket.destroyed) {
    try { socket.write(wsFrame(opcode, payload)); } catch { /* zamknięte */ }
  }
};

/**
 * Minimalna walidacja pierwszych bajtów: VarInt długości (jednobajtowy < 0x80),
 * packet id 0x00 (handshake), struktura hosta – żeby gateway nie był skanerem portów.
 */
function looksLikeMinecraft(buf) {
  if (buf.length < 4) return null; // potrzeba więcej danych
  if (buf[0] === 0 || buf[0] >= 0x80) return false; // dł. pakietu >127B nie zdarza się w handshake
  if (buf[1] !== 0x00) return false;
  // varint protokołu
  let i = 2;
  let v = 0, s = 0;
  while (i < buf.length) { const b = buf[i++]; v |= (b & 0x7f) << s; if ((b & 0x80) === 0) break; s += 7; if (s > 28) return false; }
  if (i >= buf.length) return null;
  // varint długości hosta
  let sl = 0; s = 0;
  const start = i;
  while (i < buf.length) { const b = buf[i++]; sl |= (b & 0x7f) << s; if ((b & 0x80) === 0) break; s += 7; if (s > 28) return false; }
  if (sl < 1 || sl > 255) return false;
  if (i - start > 5) return false;
  if (i + sl > buf.length) return null; // host jeszcze niecały
  return true;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 10 || p[0] === 127 || p[0] === 0) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 169 && p[1] === 254) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80")) return true;
    if (low.startsWith("::ffff:")) return isPrivateIp(low.slice(7));
  }
  return false;
}

async function openGateway(req, socket) {
  const url = new URL(req.url, "http://x");
  const host = url.searchParams.get("host") || "";
  const port = Number(url.searchParams.get("port") || 25565);
  if (!/^[A-Za-z0-9._\-]{1,253}$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); socket.destroy(); return;
  }
  const origin = req.headers.origin;
  const hostHdr = req.headers.host;
  if (origin) {
    // Za proxy podglądu Host może się różnić od Origin – realną ochroną jest
    // check handshakea MC i blokada adresów prywatnych (patrz niżej), nie ten test.
    try {
      const o = new URL(origin);
      if (o.host !== hostHdr) console.log(`[gw] origin ${o.host} ≠ host ${hostHdr} (proxy?) – przepuszczam`);
    } catch { /* nie-URL origin → przepuść, i tak niżej weryfikacja */ }
  }
  const ws = wsHandshake(req, socket);
  if (!ws) return;
  wsSend(ws, 1, Buffer.from(JSON.stringify({ t: "dialing", host, port })));

  let ip;
  try { ip = (await dns.lookup(host)).address; }
  catch { wsSend(ws, 1, Buffer.from(JSON.stringify({ t: "error", code: "DNS_FAILED" }))); ws.destroy(); return; }
  if (!ALLOW_PRIVATE && isPrivateIp(ip)) {
    wsSend(ws, 1, Buffer.from(JSON.stringify({ t: "error", code: "PRIVATE_BLOCKED" }))); ws.destroy(); return;
  }

  const tcp = net.connect({ host: ip, port });
  let handshaking = true;
  let peek = Buffer.alloc(0);
  let idle = setTimeout(() => ws.close?.(), IDLE_MS);
  const touch = () => { clearTimeout(idle); idle = setTimeout(() => { try { ws.destroy(); tcp.destroy(); } catch {} }, IDLE_MS); };

  tcp.on("connect", () => {
    wsSend(ws, 1, Buffer.from(JSON.stringify({ t: "ready", ip, port })));
    touch();
  });
  tcp.on("data", (d) => { touch(); wsSend(ws, 2, d); });
  tcp.on("error", (e) => {
    wsSend(ws, 1, Buffer.from(JSON.stringify({ t: "error", code: "CONNECT_FAILED", msg: String(e.code || e.message) })));
    try { ws.destroy(); } catch {}
  });
  tcp.on("close", () => { try { wsSend(ws, 1, Buffer.from(JSON.stringify({ t: "end" }))); ws.destroy(); } catch {} });

  // parser ramek WebSocket (klient → serwer: maskowane)
  let buf = Buffer.alloc(0);
  ws.on("data", (chunk) => {
    touch();
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) break;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) break;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) break;
        const big = buf.readBigUInt64BE(2); if (big > 16n * 1024n * 1024n) { ws.destroy(); tcp.destroy(); return; }
        len = Number(big); off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) break;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const p = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) p[i] = payload[i] ^ mask[i & 3];
        payload = p;
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x8) { try { ws.destroy(); } catch {}; tcp.destroy(); return; }
      if (opcode === 0x9) { wsSend(ws, 0xa, payload); continue; }
      if (opcode === 0x1) { // komendy tekstowe – tylko close
        try { if (JSON.parse(payload.toString()).t === "close") { ws.destroy(); tcp.destroy(); return; } } catch {}
        continue;
      }
      if (opcode !== 0x2 && opcode !== 0x0) continue; // binarne/ciąg dalszy = strumień
      if (handshaking) {
        peek = Buffer.concat([peek, payload]);
        const verdict = looksLikeMinecraft(peek);
        if (verdict === false) {
          wsSend(ws, 1, Buffer.from(JSON.stringify({ t: "error", code: "NOT_MINECRAFT" })));
          ws.destroy(); tcp.destroy(); return;
        }
        if (verdict === true) { handshaking = false; tcp.write(peek); peek = Buffer.alloc(0); }
        if (handshaking && peek.length > 512) { ws.destroy(); tcp.destroy(); return; }
      } else if (payload.length) {
        tcp.write(payload);
      }
      void fin;
    }
  });
  ws.on("error", () => { try { tcp.destroy(); } catch {} });
  ws.on("close", () => { clearTimeout(idle); try { tcp.destroy(); } catch {} });
}

server.on("upgrade", (req, socket) => {
  if ((req.url || "").startsWith("/gw")) openGateway(req, socket);
  else { socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MC Launcher Web → http://0.0.0.0:${PORT}/  (gateway: /gw)`);
});
