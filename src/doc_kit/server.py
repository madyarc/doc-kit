"""Local HTTP server for a talk.

URL layout (the talk's folder can be anywhere on disk):
  /                    the generated deck page for the talk file
  /<path>              files in the talk's folder (the .md, data/, figures/, ...)
  /_dk/engine/<path>   the doc-kit engine (shipped inside the Python package)
  /_dk/assets/<name>/  pack <name>: the talk's own `pack:` (name or path), then DOCKIT_PACKS, then built-in packs
"""
from __future__ import annotations

import functools
import html
import http.server
import pathlib
import socketserver
import threading
import urllib.parse

from . import packs as packs_mod

ENGINE = pathlib.Path(__file__).resolve().parent / "engine"

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<script type="module" src="{prefix}_dk/engine/doc-kit.js"></script>
</head>
<body data-deck="{deck}"></body>
</html>
"""


def deck_page(md_name: str, title: str, prefix: str = "/") -> str:
    return PAGE.format(title=html.escape(title or md_name), deck=html.escape(md_name), prefix=prefix)


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".md": "text/markdown; charset=utf-8",
        ".yaml": "text/yaml; charset=utf-8", ".csv": "text/csv; charset=utf-8", ".svg": "image/svg+xml",
        ".woff2": "font/woff2", ".mmd": "text/plain; charset=utf-8", ".tex": "text/plain; charset=utf-8",
    }
    talk: pathlib.Path | None = None
    root: pathlib.Path = pathlib.Path(".")
    pack_map: dict[str, pathlib.Path] = {}
    quiet = True
    record: dict[str, pathlib.Path] | None = None  # url path -> file, for every file served (doc-kit bundle)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        if not self.quiet:
            super().log_message(fmt, *args)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if self.talk and path in ("/", "/index.html"):
            body = deck_page(self.talk.name, str(packs_mod.front_matter(self.talk).get("title", ""))).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def translate_path(self, path):
        fs = self._fs_path(path)
        if self.record is not None and pathlib.Path(fs).is_file():
            self.record[urllib.parse.unquote(urllib.parse.urlsplit(path).path).lstrip("/")] = pathlib.Path(fs)
        return fs

    def _fs_path(self, path):
        path = urllib.parse.unquote(urllib.parse.urlsplit(path).path)
        parts = [p for p in path.split("/") if p and p not in (".", "..")]
        if parts[:2] == ["_dk", "engine"]:
            return str(ENGINE.joinpath(*parts[2:]))
        if parts[:2] == ["_dk", "assets"] and len(parts) >= 3:
            name = parts[2]
            folder = self.pack_map.get(name)
            if folder is None:
                try:
                    folder = packs_mod.find_pack(name)
                except FileNotFoundError:
                    return str(self.root / "__missing_pack__" / name)
            return str(folder.joinpath(*parts[3:]))
        return str(self.root.joinpath(*parts))


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def start(talk: str | pathlib.Path | None = None, root: str | pathlib.Path | None = None, port: int = 0,
          quiet: bool = True, host: str = "127.0.0.1", packs: dict | None = None, record: dict | None = None):
    """Serve a talk file (and its folder), or just a folder. `packs` adds name -> folder mappings.
    `record`, if given, is filled with url path -> file for every file served. Returns (server, base_url)."""
    talk_path = pathlib.Path(talk).resolve() if talk else None
    root_path = pathlib.Path(root).resolve() if root else (talk_path.parent if talk_path else pathlib.Path.cwd())
    pack_map = {**(packs_mod.talk_packs(talk_path) if talk_path else {}), **(packs or {})}
    handler = type("TalkHandler", (Handler,), {"talk": talk_path, "root": root_path, "pack_map": pack_map, "quiet": quiet, "record": record})
    srv = Server((host, port), functools.partial(handler, directory=str(root_path)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://{host}:{srv.server_address[1]}/"
