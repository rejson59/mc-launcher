#!/usr/bin/env python3
"""Prosty serwer statyczny dla MC Launcher Web.

- bind 0.0.0.0 (podgląd w przeglądarce)
- poprawne MIME dla .wasm/.js/.mjs/.epk (wymagane dla SW i WebAssembly)
- brak cache'owania HTML/JS podczas rozwoju
"""
import http.server
import os
import socketserver

PORT = int(os.environ.get("PORT", "8080"))
ROOT = os.path.dirname(os.path.abspath(__file__))

MIME = {
    ".wasm": "application/wasm",
    ".mjs": "text/javascript; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".epk": "application/octet-stream",
    ".epw": "application/octet-stream",
    ".json": "application/json; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def guess_type(self, path):
        _, ext = os.path.splitext(str(path))
        if ext.lower() in MIME:
            return MIME[ext.lower()]
        return super().guess_type(path)

    def end_headers(self):
        path = self.path.split("?", 1)[0]
        if path.endswith((".html", "/", ".js", ".css")) or path == "":
            self.send_header("Cache-Control", "no-cache")
        else:
            self.send_header("Cache-Control", "public, max-age=3600")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # cicho


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"MC Launcher Web → http://0.0.0.0:{PORT}/")
        httpd.serve_forever()
