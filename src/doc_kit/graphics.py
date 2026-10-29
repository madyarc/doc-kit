"""Export diagrams for papers: Mermaid sources (.mmd) -> SVG -> vector PDF.

Each .mmd is rendered to an .svg next to it in its pack's theme (so it matches the slides), and
each .svg is printed to a .pdf of the same size for \\includegraphics. Rendering uses headless
Firefox, so HTML labels, KaTeX math in labels and the pack fonts survive. Outputs are rebuilt only
when the source is newer, unless force=True.

The theme comes from the nearest enclosing pack (a folder with pack.yaml), or else from the
`pack:` of a talk (.md with front matter) in the file's folder or a parent.
"""
from __future__ import annotations

import base64
import pathlib

from . import packs as packs_mod
from . import server
from .browser import firefox, wait_for

CM_PER_PX = 2.54 / 96


def _pack_for(path: pathlib.Path):
    """(name, folder) of the pack whose theme a file should use, or None."""
    for parent in path.parents:
        if (parent / "pack.yaml").is_file():
            return parent.name, parent
        for md in sorted(parent.glob("*.md")):
            spec = packs_mod.front_matter(md).get("pack")
            if spec:
                return packs_mod.pack_name(str(spec)), packs_mod.find_pack(str(spec), md.parent)
    return None


def collect(paths) -> list[pathlib.Path]:
    files = []
    for p in map(lambda x: pathlib.Path(x).resolve(), paths):
        if p.is_dir():
            files += [f for f in sorted(p.rglob("*")) if f.suffix in (".mmd", ".svg") and "fonts" not in f.parts and "build" not in f.parts]
        elif p.suffix in (".mmd", ".svg"):
            files.append(p)
    return files


def export(paths, theme="light", force=False, out=print) -> int:
    files = collect(paths)
    mmd = [f for f in files if f.suffix == ".mmd"]
    svgs = sorted({f for f in files if f.suffix == ".svg"} | {f.with_suffix(".svg") for f in mmd})
    owners = {f: _pack_for(f) for f in set(mmd) | set(svgs)}
    srv, base = server.start(packs={n: d for n, d in filter(None, owners.values())})
    driver = firefox()
    done, current = 0, object()
    stale = lambda src, dst: force or not dst.exists() or dst.stat().st_mtime < src.stat().st_mtime  # noqa: E731

    def page(owner):
        nonlocal current
        if owner == current:
            return
        driver.get(f"{base}_dk/engine/tools/render_graphics.html")
        wait_for(driver, "graphicsReady")
        styles = []
        if owner:
            name, folder = owner
            cfg = packs_mod.load_config(folder)
            styles = [f"{base}_dk/assets/{name}/{s}" for s in ([cfg["styles"]] if isinstance(cfg.get("styles"), str) else cfg.get("styles", []))]
        driver.execute_async_script("usePack(arguments[0], arguments[1]).then(arguments[2])", styles, theme)
        current = owner

    try:
        for src in mmd:
            dst = src.with_suffix(".svg")
            if not stale(src, dst):
                continue
            page(owners[src])
            svg = driver.execute_async_script(
                "const done = arguments[1]; renderMermaid(arguments[0]).then(done, (e) => done('ERROR ' + e.message))", src.read_text())
            if svg.startswith("ERROR"):
                out(f"FAIL {src}: {svg[6:]}")
                continue
            dst.write_text('<?xml version="1.0" encoding="UTF-8"?>\n' + svg)
            out(f"wrote {dst}")
            done += 1
        from selenium.webdriver.common.print_page_options import PrintOptions
        for src in svgs:
            dst = src.with_suffix(".pdf")
            if not src.exists() or not stale(src, dst):
                continue
            page(owners.get(src))
            w, h = driver.execute_async_script("showSvg(arguments[0]).then(arguments[1])", src.read_text())
            opts = PrintOptions()
            opts.page_width, opts.page_height = w * CM_PER_PX, h * CM_PER_PX
            opts.margin_top = opts.margin_bottom = opts.margin_left = opts.margin_right = 0
            opts.background = True
            opts.shrink_to_fit = False
            dst.write_bytes(base64.b64decode(driver.print_page(opts)))
            out(f"wrote {dst} ({w:.0f}x{h:.0f}px)")
            done += 1
    finally:
        driver.quit()
        srv.shutdown()
    return done
