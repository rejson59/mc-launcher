/**
 * patcher.js – nakładanie poprawek na POBRANY (własny) client.jar, po stronie
 * przeglądarki. Zero redystrybucji: modyfikujemy bajty, które użytkownik sam
 * pobrał z Mojang, na jego urządzeniu.
 *
 * Operacje (czysta manipulacja formatem .class z JLS):
 *  - const0:   podmiana ciała metody na `iconst_0; ireturn` (albo `return`)
 *  - fieldref: w kodzie metody GETSTATIC/PUTSTATIC stare pole → nowe
 *  - nonnull:  `return this.callee(arg) != null`
 *
 * Zestaw dla 1.12.2 = cztery znane poprawki (wymagane pod CheerpJ: raport
 * crashów, sieć lokalna bez NIO-selekora, szybkie hasResource, NPE w modelach).
 * Dla innych wersji używamy oficjalnych mapowań Mojang (clientMappings), żeby
 * znaleźć te same metody po nazwach; brak mapowań = pomijamy (wersje ≤1.6
 * tych ścieżek zwykle nie mają).
 */

/* ---------------- ZIP (czytanie + zapis, deflate przez CompressionStream) ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(buf) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function deflateRaw(buf) {
  const cs = new CompressionStream("deflate-raw");
  const stream = new Blob([buf]).stream().pipeThrough(cs);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** [{name, method, data}] – kolejność zachowana; dane rozpakowane. */
export async function readZip(zipBytes) {
  const dv = new DataView(zipBytes.buffer, zipBytes.byteOffset, zipBytes.byteLength);
  // EOCD: szukamy od końca sygnatury 0x06054b50
  let eocd = -1;
  for (let i = zipBytes.length - 22; i >= Math.max(0, zipBytes.length - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("ZIP: brak EOCD");
  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("ZIP: zły rekord centralny");
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zipBytes.subarray(p + 46, p + 46 + nameLen));
    // nagłówek lokalny
    if (dv.getUint32(localOff, true) !== 0x04034b50) throw new Error("ZIP: zły lokalny: " + name);
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataOff = localOff + 30 + lNameLen + lExtraLen;
    const comp = zipBytes.subarray(dataOff, dataOff + compSize);
    const data = method === 0 ? comp.slice() : await inflateRaw(comp);
    entries.push({ name, method, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export async function writeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();
  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const comp = e.method === 8 ? await deflateRaw(e.data) : e.data;
    const crc = crc32(e.data);
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); // UTF-8 flag
    lv.setUint16(8, e.method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    parts.push(local, comp);
    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, e.method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += local.length + comp.length;
  }
  const cdBytes = concat(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdBytes.length, true);
  ev.setUint32(16, offset, true);
  return concat([...parts, cdBytes, eocd]);
}
function concat(list) {
  const len = list.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const a of list) { out.set(a, o); o += a.length; }
  return out;
}

/* ---------------- parse .class (minimum do poprawek) ---------------- */

function utf8Str(dv, bytes, cp, idx) {
  const off = cp[idx];
  const len = dv.getUint16(off + 1, true);
  return new TextDecoder("utf-8").decode(bytes.subarray(off + 3, off + 3 + len));
}

function parseClass(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(0) !== 0xcafebabe) throw new Error("to nie jest .class");
  const cpCount = dv.getUint16(8, true);
  const cp = new Array(cpCount);
  const cpTag = new Array(cpCount);
  const cpRef = new Array(cpCount); // {a,b} dla dwuczłonowych
  let off = 10;
  for (let i = 1; i < cpCount; i++) {
    cp[i] = off;
    const tag = bytes[off];
    cpTag[i] = tag;
    if (tag === 1) { const l = dv.getUint16(off + 1, true); off += 3 + l; }
    else if (tag === 7 || tag === 8 || tag === 16 || tag === 19 || tag === 20) { cpRef[i] = { a: dv.getUint16(off + 1, true) }; off += 3; }
    else if (tag === 15) { cpRef[i] = { a: bytes[off + 1], b: dv.getUint16(off + 2, true) }; off += 4; }
    else if (tag === 9 || tag === 10 || tag === 11 || tag === 12 || tag === 17 || tag === 18) { cpRef[i] = { a: dv.getUint16(off + 1, true), b: dv.getUint16(off + 3, true) }; off += 5; }
    else if (tag === 3 || tag === 4) off += 5;
    else if (tag === 5 || tag === 6) { off += 9; i++; }
    else throw new Error("CP tag " + tag);
  }
  const thisClassIdx = dv.getUint16(off + 2, true); // access u2, this_class u2
  const utf8 = (idx) => (idx && cpTag[idx] === 1 ? utf8Str(dv, bytes, cp, idx) : null);
  const classNameAt = (idx) => utf8(cpRef[idx]?.a); // Class → name
  let p = off;
  p += 6; // access, this, super
  const ifCount = dv.getUint16(p, true); p += 2 + ifCount * 2;
  const fieldCount = dv.getUint16(p, true); p += 2;
  const fields = [];
  for (let i = 0; i < fieldCount; i++) {
    const nameIdx = dv.getUint16(p, true);
    const descIdx = dv.getUint16(p + 2, true);
    const ac = dv.getUint16(p + 6, true);
    fields.push({ name: utf8(nameIdx), desc: utf8(descIdx), nameIdx, descIdx });
    p += 8;
    for (let a = 0; a < ac; a++) {
      const al = dv.getUint32(p + 2, true);
      p += 6 + al;
    }
  }
  const methodCount = dv.getUint16(p, true); p += 2;
  const methods = [];
  for (let i = 0; i < methodCount; i++) {
    const nameIdx = dv.getUint16(p, true);
    const descIdx = dv.getUint16(p + 2, true);
    const ac = dv.getUint16(p + 6, true);
    let ap = p + 8;
    let codeOff = -1, codeLen = -1;
    for (let a = 0; a < ac; a++) {
      const an = utf8(dv.getUint16(ap, true));
      const al = dv.getUint32(ap + 2, true);
      if (an === "Code") { codeOff = ap + 6; codeLen = al; }
      ap += 6 + al;
    }
    methods.push({
      name: utf8(nameIdx), desc: utf8(descIdx), nameIdx, descIdx,
      attrCount: ac, attrsStart: p + 8, attrsEnd: ap, codeOff, codeLen,
      methodStart: p, methodEnd: ap,
    });
    p = ap;
  }
  return { dv, bytes, cp, cpTag, cpRef, utf8, classNameAt, fields, methods, thisClassIdx };
}

function codeAttrBody(maxLocals, body) {
  const buf = new Uint8Array(8 + body.length + 4);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, Math.max(2, maxStackFor(body)), true);
  dv.setUint16(2, maxLocals, true);
  dv.setUint32(4, body.length, true);
  buf.set(body, 8);
  // ostatnie 4 bajty: exception_table_length=0, attributes_count=0
  return buf;
}
function maxStackFor(body) {
  // wystarczająco dla naszych mini-ciał (≤3 slotów)
  void body;
  return 4;
}

/** Przepisuje atrybut Code wybranej metody (parse → nowe ciało → reassemble metody). */
function replaceMethodCode(cls, method, newBody, maxLocals) {
  const { bytes, dv } = cls;
  if (method.codeOff < 0) throw new Error("metoda bez Code: " + method.name);
  const newCode = codeAttrBody(maxLocals, newBody);
  const oldCodeLen = method.codeLen; // długość treśći atrybutu Code
  // metoda: [name u2][desc u2][ac u2][attr...]; szukamy Code-attr, podmieniamy jego length+bytes
  let ap = method.attrsStart;
  for (let a = 0; a < method.attrCount; a++) {
    const an = cls.utf8(dv.getUint16(ap, true));
    const al = dv.getUint32(ap + 2, true);
    if (an === "Code") {
      // ap+0: name_idx, ap+2: len, ap+6: treść (oldCodeLen)
      const head = bytes.subarray(0, ap + 6);
      const tail = bytes.subarray(ap + 6 + oldCodeLen);
      const out = concat([head, newCode, tail]);
      // przepisz referencje: wszystkie offsety dalszych struktur przesunięte
      return { newBytes: out, delta: newCode.length - oldCodeLen };
    }
    ap += 6 + al;
  }
  throw new Error("Code nie znaleziony");
}

/** Reasamble klasy: parsujemy od nowa i sklejamy z nowym tablicą metod (zamiana bajtów w miejscu przez concat). */
function rebuildWithMethod(cls, method, newBody, maxLocals) {
  // prościej: pracujemy na rozpakowanym buforze – sekcja metod jest OSTATNIA jeśli
  // nie ma atrybutów klasy po metodach… w .class atrybuty klasy idą PO metodach.
  // Robimy konserwatywnie: wstawiamy nowe bajty w Code i poprawiamy długość atrybutu;
  // dalsze offsety (następne metody, atrybuty klasy) przesuwamy o delta – ale metody
  // trzymają własne pozycje tylko informacyjnie (nie używane przy zapisie), więc
  // WYSTARCZY poprawić długość atrybutu Code i resztę przesunąć.
  const r = replaceMethodCode(cls, method, newBody, maxLocals);
  return r.newBytes;
}

function argSlots(desc) {
  // liczba slotów z opisu (bez return), uwzględniając this
  let slots = 1;
  let i = 1;
  while (desc[i] && desc[i] !== ")") {
    while (desc[i] === "[") i++;
    if (desc[i] === 'L') { while (desc[i] !== ';') i++; slots++; i++; }
    else if (desc[i] === 'J' || desc[i] === 'D') { slots += 2; i++; }
    else { slots++; i++; }
  }
  return slots;
}

/* ---------------- operacje na kodzie ---------------- */

function opConst0(desc) {
  const ret = desc.slice(desc.indexOf(')') + 1);
  if (ret === "V") return [0xb1];               // return
  if (ret === "J" || ret === "D") return [0x0e, 0xad]; // lconst_0/dconst_0 + lreturn/dreturn
  if (ret === "Z" || ret === "B" || ret === "C" || ret === "S" || ret === "I") return [0x03, 0xac];
  if (ret === "F") return [0x0b, 0xae];
  return [0x01, 0xb0];                          // aconst_null + areturn
}

/** invokevirtual this.callee(args) → callee!=null ? 1 : 0 (desc: (…)Z) */
function opNonNull(cls, callee) {
  const slots = argSlots(callee.desc);
  const body = [];
  for (let i = 0; i < slots; i++) body.push(0x2a + i); // aload_0.. — UWAGA tylko do 3
  if (slots > 3) throw new Error("nonnull: za dużo argów");
  const idx = cpIndexForVirtual(cls, callee);
  body.push(0xb6, (idx >> 8) & 0xff, idx & 0xff); // invokevirtual
  body.push(0xc7, 0x00, 0x05);                    // ifnull → +5
  body.push(0x03, 0xac);                          // iconst_0; ireturn
  body.push(0x04, 0xac);                          // iconst_1; ireturn
  return body;
}
function cpIndexForVirtual(cls, callee) {
  // znajdź/utwórz CONSTANT_Methodref (this class, name, desc)
  const { dv, bytes, cp, cpTag, cpRef } = cls;
  const thisIdx = dv.getUint16(6 + 2, true); // this_class (po magic u4 + minor u2 + major u2 + cp)
  // WAIT: layout: 0 magic u4,4 minor u2,6 major u2,8 cpCount u2 … cp konczy sie → off
  void thisIdx;
  const thisClass = cls.thisClassIdx;
  for (let i = 1; i < cp.length; i++) {
    if (cpTag[i] !== 10) continue; // Methodref
    const clsIdx = cpRef[i].a;
    if (cpTag[clsIdx] !== 7) continue;
    if (cpRef[clsIdx].a !== thisClass) continue;
    const nat = cpRef[i].b;
    if (cls.utf8(cpRef[nat].a) === callee.name && cls.utf8(cpRef[nat].b) === callee.desc) return i;
  }
  throw new Error("cp: Methodref nie znaleziony: " + callee.name + callee.desc);
}

/** GETSTATIC stare pole → nowe (tylko w kodzie danej metody). */
function opFieldref(cls, method, oldName, newName) {
  if (method.codeOff < 0) throw new Error("brak Code");
  const { dv, bytes, cpTag, cpRef } = cls;
  const codeStart = method.codeOff + 8;
  const codeLen = dv.getUint32(method.codeOff + 4, true);
  const code = bytes.subarray(codeStart, codeStart + codeLen);
  let newUtf8 = -1;
  for (let i = 1; i < cls.cp.length; i++) {
    if (cpTag[i] === 1 && cls.utf8(i) === newName) { newUtf8 = i; break; }
  }
  if (newUtf8 < 0) throw new Error("utf8 " + newName + " nie istnieje w CP");
  let touched = 0;
  // prosty skan bajtów (nasze metody nie mają tableswitch — bezpieczne dla szczątkowych ciał)
  for (let i = 0; i < code.length - 2; i++) {
    const op = code[i];
    if (op === 0xb2 || op === 0xb3 || op === 0xb4 || op === 0xb5) { // *STATIC/*FIELD
      const idx = (code[i + 1] << 8) | code[i + 2];
      if (cpTag[idx] === 9) { // Fieldref
        const nat = cpRef[idx].b;
        if (cpTag[nat] === 12 && cls.utf8(cpRef[nat].a) === oldName) {
          const off = cp[nat] + 1; // NameAndType: name_idx u2
          dv.setUint16(off, newUtf8, true);
          touched++;
        }
      }
      i += 2;
    }
  }
  if (!touched) throw new Error(`fieldref: nie widzę pola ${oldName} w ${method.name}${method.desc}`);
  return touched;
}

/* ---------------- mapowania ProGuard (odwrotne) ---------------- */

function parseMappings(text) {
  // class:  a -> net.minecraft.Foo:
  // member:   b (Lnf;)Z -> hasResource
  const byOfficialClass = new Map();
  const memberByOfficialName = new Map(); // "hasResource" → [{obfClass, obfName, desc}]
  let curObf = null;
  for (const line of text.split("\n")) {
    let m = /^(\S+) -> ([\w.$]+):$/.exec(line);
    if (m) { curObf = m[1]; byOfficialClass.set(m[2], curObf); continue; }
    m = /^\s+(\S+) (\(.*?\)\S*?) -> (\S+)$/.exec(line);
    if (m && curObf) {
      const [, obfName, desc, official] = m;
      if (!memberByOfficialName.has(official)) memberByOfficialName.set(official, []);
      memberByOfficialName.get(official).push({ obfClass: curObf, obfName, desc });
    }
  }
  return { byOfficialClass, memberByOfficialName };
}

/* ---------------- plan poprawek dla wersji ---------------- */

async function patchPlanFor(id, mappingsText) {
  const plan = [];
  if (id === "1.12.2") {
    plan.push({ op: "const0", cls: "c", method: "a", desc: "(I)I" });
    plan.push({ op: "fieldref", cls: "oz", method: "a", desc: "()Ljava/net/SocketAddress;", old: "a", neu: "c" });
    plan.push({ op: "nonnull", cls: "cee", method: "b", desc: "(Lnf;)Z", calleeCls: "cee", calleeName: "a", calleeDesc: "(Lnf;)Ljava/io/File;" });
    plan.push({ op: "const0", cls: "bvu", method: "b", desc: "(Ljava/util/Map;)V" });
    return plan;
  }
  if (!mappingsText) return plan;
  const { byOfficialClass, memberByOfficialName } = parseMappings(mappingsText);

  // 1) CrashReport*: metoda (I)I z Thread.getStackTrace → const0
  const crashClass = [...byOfficialClass.entries()]
    .find(([official]) => /CrashReport/.test(official) && !/Category.*File/.test(official));
  if (crashClass) plan.push({ op: "const0-ish", cls: crashClass[1], methodDesc: "(I)I", detect: "getStackTrace" });

  // 2) NetworkSystem: ()LSocketAddress; z GETSTATIC EventLoopGroup → druga grupa
  const ns = byOfficialClass.get("net.minecraft.network.NetworkSystem")
    || [...byOfficialClass.entries()].find(([o]) => o.endsWith(".NetworkSystem"))?.[1];
  if (ns) plan.push({ op: "eventloop", cls: ns, methodDesc: "()Ljava/net/SocketAddress;" });

  // 3) hasResource → nonnull(callee zwracający File)
  for (const hit of memberByOfficialName.get("hasResource") || []) {
    plan.push({ op: "nonnull-gen", cls: hit.obfClass, method: hit.obfName, desc: hit.desc });
    break;
  }
  // 4) checkModelHierarchy → const0
  for (const hit of memberByOfficialName.get("checkModelHierarchy") || []) {
    plan.push({ op: "const0", cls: hit.obfClass, method: hit.obfName, desc: hit.desc });
    break;
  }
  return plan;
}

/* ---------------- wejście ---------------- */

/**
 * Zwraca nowe bajty client.jar albo null (brak poprawek dla tej wersji).
 * mappingsLoader: async () => string | null (tekst clientMappings).
 */
export async function applyPatches(id, jarBytes, mappingsLoader) {
  const mappingsText = id === "1.12.2" ? null : await mappingsLoader?.();
  const plan = await patchPlanFor(id, mappingsText);
  if (!plan.length) return null;
  const entries = await readZip(jarBytes);
  let changed = 0;
  for (const e of entries) {
    if (!e.name.startsWith("net/minecraft") && !plan.some((p) => e.name === p.cls.replace(/\./g, "/") + ".class")) continue;
    const simple = e.name.replace(/\.class$/, "").split("/").pop();
    const rel = e.name.replace(/\.class$/, "");
    for (const p of plan) {
      if (rel !== p.cls && simple !== p.cls) continue;
      try {
        const cls = parseClass(e.data);
        if (p.op === "const0") {
          const m = cls.methods.find((x) => x.name === p.method && x.desc === p.desc);
          if (m) { e.data = rebuildWithMethod(cls, m, opConst0(m.desc), argSlots(m.desc)); changed++; }
        } else if (p.op === "const0-ish") {
          const m = cls.methods.find((x) => x.desc === p.methodDesc &&
            /java\/lang\/Thread/.test(new TextDecoder().decode(e.data.subarray(x.codeOff, x.codeOff + x.codeLen))));
          if (m) { e.data = rebuildWithMethod(cls, m, opConst0(m.desc), argSlots(m.desc)); changed++; }
        } else if (p.op === "fieldref") {
          const m = cls.methods.find((x) => x.name === p.method && x.desc === p.desc);
          if (m) { opFieldref(cls, m, p.old, p.neu); changed++; } // modyfikacja CP w miejscu
        } else if (p.op === "nonnull") {
          const m = cls.methods.find((x) => x.name === p.method && x.desc === p.desc);
          const callee = cls.methods.find((x) => x.name === p.calleeName && x.desc === p.calleeDesc);
          if (m && callee) {
            const body = opNonNull(cls, callee);
            e.data = rebuildWithMethod(cls, m, body, argSlots(m.desc));
            changed++;
          }
        } else if (p.op === "nonnull-gen") {
          const m = cls.methods.find((x) => x.name === p.method && x.desc === p.desc);
          const retIdx = p.desc.indexOf(")") + 1;
          const argsDesc = p.desc.slice(0, retIdx);
          const callee = cls.methods.find((x) => x.desc === argsDesc + "Ljava/io/File;" && x.name !== p.method);
          if (m && callee) {
            e.data = rebuildWithMethod(cls, m, opNonNull(cls, callee), argSlots(p.desc));
            changed++;
          }
        } else if (p.op === "eventloop") {
          const m = cls.methods.find((x) => x.desc === p.methodDesc);
          if (m && m.codeOff >= 0) {
            const groups = cls.fields.filter((f) => /EventLoopGroup;/.test(f.desc));
            if (groups.length >= 2) {
              // w kodzie metody: GETSTATIC grupy #0 → grupy #1 (wzorce jak w teście portu)
              const { dv, bytes, cpTag, cpRef } = cls;
              const codeStart = m.codeOff + 8;
              const codeLen = dv.getUint32(m.codeOff + 4, true);
              const code = bytes.subarray(codeStart, codeStart + codeLen);
              for (let i = 0; i < code.length - 2; i++) {
                if (code[i] === 0xb2) {
                  const idx = (code[i + 1] << 8) | code[i + 2];
                  if (cpTag[idx] === 9) {
                    const nat = cpRef[idx].b;
                    const fieldName = cls.utf8(cpRef[nat].a);
                    const fi = groups.findIndex((g) => g.name === fieldName);
                    if (fi >= 0) {
                      const target = groups[(fi + 1) % groups.length];
                      const utf = cls.fields.find((f) => f.name === target.name)?.nameIdx;
                      if (utf) { dv.setUint16(cp[nat] + 1, utf, true); changed++; }
                    }
                  }
                  i += 2;
                }
              }
            }
          }
        }
      } catch (err) {
        console.warn("[patcher]", p, err.message);
      }
    }
  }
  if (!changed) return null;
  return await writeZip(entries);
}
