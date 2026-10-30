"""Bundle a talk into one self-contained .html file that opens by double-click (file://).

The file holds the engine, the vendored libraries, the pack and every file the deck loads (the
talk, data, figures, fonts), so it needs no Python, no server and no internet. To find out what the
deck loads, the talk is served locally and opened once in headless Firefox; every file it fetches
goes into the bundle. Fonts referenced from stylesheets are inlined as data: URLs.

Inside the page, window.docKitBundle serves those files from memory with the same layout as a built
folder (talk files at the top, _dk/engine/, _dk/assets/<pack>/), and fetch() is routed to it.
"""
from __future__ import annotations

import base64
import html
import json
import mimetypes
import pathlib
import re
import time

from . import packs as packs_mod
from . import server

TEXT = {".md", ".csv", ".tsv", ".yaml", ".yml", ".tex", ".mmd", ".svg", ".css", ".js", ".json", ".txt", ".html"}
MIME = {".md": "text/markdown", ".csv": "text/csv", ".yaml": "text/yaml", ".yml": "text/yaml", ".tex": "text/plain",
        ".mmd": "text/plain", ".svg": "image/svg+xml", ".js": "text/javascript", ".woff2": "font/woff2",
        ".woff": "font/woff", ".ttf": "font/ttf", ".gif": "image/gif", ".webp": "image/webp"}
# The engine's ES modules, dependencies first; they are joined into one inline module.
MODULES = ["math.js", "source.js", "render.js", "components.js", "doc-kit.js"]

BOOT = r"""
window.docKitBundle = (() => {
  const files = JSON.parse(document.getElementById('dk-files').textContent);
  const base = new URL('./', location.href).href;
  const key = (u) => {
    const h = new URL(u, location.href);
    h.search = ''; h.hash = '';
    return h.href.startsWith(base) ? decodeURIComponent(h.href.slice(base.length)) : null;
  };
  const get = (u) => { const k = key(u); return (k != null && files[k]) || null; };
  const bytes = (f) => (f.b64 != null ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : f.text);
  const blobs = new Map();
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const f = get(typeof input === 'string' ? input : input.url || String(input));
    if (!f) return realFetch(input, init);
    return Promise.resolve(new Response(new Blob([bytes(f)], { type: f.type }), { status: 200, headers: { 'Content-Type': f.type } }));
  };
  return {
    text(u) { const f = get(u); return f ? (f.text != null ? f.text : new TextDecoder().decode(bytes(f))) : null; },
    url(u) {
      const k = key(u), f = k != null && files[k];
      if (!f) return null;
      if (!blobs.has(k)) blobs.set(k, URL.createObjectURL(new Blob([bytes(f)], { type: f.type })));
      return blobs.get(k);
    },
  };
})();
"""

PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="doc-kit bundle">
<title>{title}</title>
<script type="application/json" id="dk-files">{files}</script>
<script>{boot}</script>
<script type="module">
{engine}
</script>
</head>
<body data-deck="{deck}"></body>
</html>
"""


def _mime(path: pathlib.Path) -> str:
    return MIME.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def _data_url(path: pathlib.Path) -> str:
    return f"data:{_mime(path)};base64,{base64.b64encode(path.read_bytes()).decode()}"


def _inline_css(text: str, css_file: pathlib.Path) -> str:
    """Inline url(...) references (fonts, images) of a stylesheet as data: URLs."""
    # Fonts with several formats: woff2 is enough for every current browser.
    text = re.sub(r""",\s*url\(\s*['"]?[^'")]+\.(?:woff|ttf|otf|eot)(?:[?#][^'")]*)?['"]?\s*\)\s*format\(\s*['"][^'"]*['"]\s*\)""", "", text)

    def repl(m):
        ref = m.group(2)
        if re.match(r"^(data:|https?:|#|/)", ref):
            return m.group(0)
        f = (css_file.parent / ref.split("?")[0].split("#")[0]).resolve()
        return f'url("{_data_url(f)}")' if f.is_file() else m.group(0)
    return re.sub(r"""url\(\s*(['"]?)([^'")]+)\1\s*\)""", repl, text)


def _engine_module() -> str:
    """The engine's modules joined into one: each module becomes a scope that returns its exports."""
    out = []
    for name in MODULES:
        code = (server.ENGINE / name).read_text()
        var = "__dk_" + name[:-3].replace("-", "_")

        def imp(m):
            return f"const {{{m.group(1)}}} = __dk_{m.group(2).replace('-', '_')};"
        code = re.sub(r"^import\s*\{([^}]*)\}\s*from\s*'\./([\w-]+)\.js';", imp, code, flags=re.M)
        exports = re.findall(r"^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([\w$]+)", code, flags=re.M)
        code = re.sub(r"^export\s+", "", code, flags=re.M)
        if name == MODULES[-1]:
            out.append(f"// ---- {name}\n{code}")
        else:
            out.append(f"// ---- {name}\nconst {var} = (() => {{\n{code}\nreturn {{ {', '.join(exports)} }};\n}})();")
    return "\n".join(out).replace("</script", "<\\/script")


def _collect(talk: pathlib.Path, timeout=120) -> dict[str, pathlib.Path]:
    """Every file the deck loads, as url path -> file, found by opening it once in headless Firefox."""
    from .browser import firefox, open_deck
    record: dict[str, pathlib.Path] = {}
    srv, base = server.start(talk, record=record)
    driver = firefox()
    try:
        rep = open_deck(driver, f"{base}?nowatch", timeout=timeout)
        for e in rep["errors"]:
            print(f"warning: {e}")
        end = time.time() + timeout
        while not driver.execute_script("return [...document.images].every((i) => i.complete)") and time.time() < end:
            time.sleep(0.2)
    finally:
        driver.quit()
        srv.shutdown()
    return record


def bundle(talk, out=None) -> pathlib.Path:
    talk = pathlib.Path(talk).resolve()
    out = pathlib.Path(out).resolve() if out else talk.parent / "build" / f"{talk.stem}.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    files = {}
    for key, path in sorted(_collect(talk).items()):
        if key in ("", "index.html") or (key.startswith("_dk/engine/") and key.endswith(".js") and "/" not in key[11:]):
            continue  # the page itself and the engine modules (inlined below)
        suffix = path.suffix.lower()
        if suffix == ".css":
            files[key] = {"type": "text/css", "text": _inline_css(path.read_text(), path)}
        elif suffix in TEXT:
            files[key] = {"type": _mime(path), "text": path.read_text()}
        else:
            files[key] = {"type": _mime(path), "b64": base64.b64encode(path.read_bytes()).decode()}
    files.setdefault(talk.name, {"type": "text/markdown", "text": talk.read_text()})
    data = json.dumps(files, ensure_ascii=False, separators=(",", ":")).replace("<", "\\u003c")
    title = str(packs_mod.front_matter(talk).get("title", "")) or talk.stem
    out.write_text(PAGE.format(title=html.escape(title), files=data, boot=BOOT, engine=_engine_module(),
                               deck=html.escape(talk.name)), encoding="utf-8")
    return out
