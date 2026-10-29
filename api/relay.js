/**
 * /api/relay – jednokierunkowe proxy plików Minecrafta na Vercel.
 *
 * Cel: ominąć CORS i blokady sieciowe na libraries.minecraft.net itp.
 * z perspektywy przeglądarki. Bezpieczne z natury:
 *  - allowlista hostów (Mojang + mirror, żadnego otwartego proxy),
 *  - tylko GET/HEAD, redirecti sprawdzane host-po-hopie,
 *  - weryfikacja SHA-1 po stronie klienta (tu tylko transport),
 *  - Range przekazywane dalej (obsługa dużych plików po kawałkach).
 */
import { Readable } from "node:stream";

const ALLOW = new Set([
  "piston-meta.mojang.com",
  "piston-data.mojang.com",
  "launchermeta.mojang.com",
  "libraries.minecraft.net",
  "launcher.mojang.com",
  "resources.download.minecraft.net",
  "textures.minecraft.net",
  "session.mojang.com",
  "sessionserver.mojang.com",
  "api.mojang.com",
  "repo1.maven.org",
]);

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "range, content-type");
  res.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "method" }));
  }

  let target;
  try {
    const raw = (req.query && req.query.url) || new URL(req.url, "http://x").searchParams.get("url");
    target = new URL(raw);
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: "bad url" }));
  }
  if (target.protocol !== "https:") target.protocol = "https:";
  if (!ALLOW.has(target.hostname)) {
    res.statusCode = 403;
    return res.end(JSON.stringify({ error: "host not allowed", host: target.hostname }));
  }

  const fwd = {};
  if (req.headers.range) fwd.range = req.headers.range;

  let up;
  try {
    for (let hop = 0; hop < 4; hop++) {
      up = await fetch(target, {
        headers: { ...fwd, "accept-encoding": "identity" },
        redirect: "manual",
        signal: AbortSignal.timeout(25000),
      });
      if (up.status >= 300 && up.status < 400 && up.headers.get("location")) {
        target = new URL(up.headers.get("location"), target);
        if (target.protocol !== "https:" || !ALLOW.has(target.hostname)) {
          res.statusCode = 403;
          return res.end(JSON.stringify({ error: "redirect host not allowed", host: target.hostname }));
        }
        continue;
      }
      break;
    }
  } catch (e) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: "upstream", message: String((e && e.message) || e) }));
  }

  const keep = ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified"];
  res.statusCode = up.status;
  for (const h of keep) {
    const v = up.headers.get(h);
    if (v) res.setHeader(h, v);
  }

  if (req.method === "HEAD" || !up.body) return res.end();
  try {
    await new Promise((resolve, reject) => {
      const stream = Readable.fromWeb(up.body);
      stream.on("error", reject);
      res.on("close", () => stream.destroy());
      stream.pipe(res);
      res.on("finish", resolve);
    });
  } catch {
    if (!res.writableEnded) res.end();
  }
}
