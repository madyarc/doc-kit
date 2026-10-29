"""Build a talk into a standalone folder (host it anywhere) and/or a PDF."""
from __future__ import annotations

import base64
import pathlib
import shutil

from . import packs as packs_mod
from . import server

# Not copied into a build: build output, hidden files, scripts and raw run logs/history.
SKIP_DIRS = {"build", "__pycache__", "logs", "history", ".git"}
SKIP_SUFFIXES = {".py", ".pyc"}
CM_PER_PX = 2.54 / 96


def _ignore(directory, names):
    return [n for n in names if n.startswith(".") or n in SKIP_DIRS or pathlib.Path(n).suffix in SKIP_SUFFIXES]


def build_html(talk, out=None) -> pathlib.Path:
    """Copy the talk, the engine and the packs it uses into `out` (default: <talk dir>/build/<stem>).
    Serve that folder with any static web server (browsers block decks opened as file://)."""
    talk = pathlib.Path(talk).resolve()
    out = pathlib.Path(out).resolve() if out else talk.parent / "build" / talk.stem
    if out.exists():
        shutil.rmtree(out)
    shutil.copytree(talk.parent, out, ignore=_ignore)
    shutil.copytree(server.ENGINE, out / "_dk" / "engine", ignore=shutil.ignore_patterns("tools", "__pycache__"))
    for name, folder in packs_mod.talk_packs(talk).items():
        shutil.copytree(folder, out / "_dk" / "assets" / name, ignore=shutil.ignore_patterns("latex", "__pycache__", "*.py"))
    title = str(packs_mod.front_matter(talk).get("title", ""))
    (out / "index.html").write_text(server.deck_page(talk.name, title, prefix=""))
    return out


def build_pdf(talk, out=None, steps=False, theme="light") -> pathlib.Path:
    from selenium.webdriver.common.print_page_options import PrintOptions
    from .browser import firefox, open_deck
    talk = pathlib.Path(talk).resolve()
    out = pathlib.Path(out).resolve() if out else talk.parent / "build" / f"{talk.stem}{'-steps' if steps else ''}.pdf"
    out.parent.mkdir(parents=True, exist_ok=True)
    srv, base = server.start(talk)
    driver = firefox()
    try:
        rep = open_deck(driver, f"{base}?{'print=steps' if steps else 'print'}&theme={theme}&nowatch")
        for e in rep["errors"]:
            print(f"warning: {e}")
        opts = PrintOptions()
        opts.page_width, opts.page_height = 1280 * CM_PER_PX, 720 * CM_PER_PX
        opts.margin_top = opts.margin_bottom = opts.margin_left = opts.margin_right = 0
        opts.background = True
        opts.shrink_to_fit = False
        out.write_bytes(base64.b64decode(driver.print_page(opts)))
    finally:
        driver.quit()
        srv.shutdown()
    return out
