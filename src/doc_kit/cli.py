"""doc-kit command line.

    doc-kit serve TALK.md [--port 8000]       open in a browser at the printed URL; reloads on save
    doc-kit build TALK.md [-o DIR] [--pdf]     standalone folder (host anywhere) and/or a PDF
    doc-kit pdf TALK.md [--steps] [--theme dark]
    doc-kit check TALK.md [--shots DIR] [--all-steps]
    doc-kit packs                              list the packs doc-kit can find
    doc-kit math-check [PACK ...]              math assets in KaTeX and LaTeX
    doc-kit sty PACK [--bundle DIR]            LaTeX package for a pack's math assets
    doc-kit graphics PATH ... [--force]        .mmd -> .svg -> .pdf for papers

A talk can live in any folder. Its `pack:` is a name (found on DOCKIT_PACKS or among the packs
shipped with doc-kit) or a path relative to the talk file. check, pdf, math-check and graphics
need: pip install "doc-kit[tools]" and Firefox.
"""
from __future__ import annotations

import argparse
import pathlib
import sys
import threading


def _talk(path):
    p = pathlib.Path(path).expanduser().resolve()
    if not p.is_file():
        sys.exit(f"no such file: {p}")
    return p


def cmd_serve(a):
    from . import server
    talk = _talk(a.talk)
    srv, base = server.start(talk, port=a.port, quiet=not a.verbose, host=a.host)
    print(f"doc-kit: serving {talk}\n  open {base}\n  (s: speaker view, t: light/dark, ?: keys; Ctrl+C to stop)")
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        srv.shutdown()


def cmd_build(a):
    from . import build
    talk = _talk(a.talk)
    if not a.no_html:
        out = build.build_html(talk, a.out)
        print(f"wrote {out}/ (serve it with any static web server, e.g. python3 -m http.server -d {out})")
    if a.pdf:
        print(f"wrote {build.build_pdf(talk, steps=a.steps, theme=a.theme)}")


def cmd_pdf(a):
    from . import build
    print(f"wrote {build.build_pdf(_talk(a.talk), a.out, steps=a.steps, theme=a.theme)}")


def cmd_check(a):
    from .check import check_talk
    talk = _talk(a.talk)
    print(f"{talk.name}:")
    n = check_talk(talk, themes=a.themes.split(","), shots=a.shots, all_steps=a.all_steps)
    print("OK" if not n else f"{n} problem(s)")
    sys.exit(1 if n else 0)


def cmd_packs(a):
    from . import packs
    for name, folder in packs.all_packs().items():
        print(f"{name:16s} {folder}")


def cmd_math_check(a):
    from .mathcheck import check_packs
    n = check_packs(a.packs)
    print("OK" if not n else f"{n} failure(s)")
    sys.exit(1 if n else 0)


def cmd_sty(a):
    from . import packs
    from .sty import build_sty
    print(f"wrote {build_sty(packs.find_pack(a.pack), a.bundle, a.root)}")


def cmd_graphics(a):
    from .graphics import export
    n = export(a.paths, theme=a.theme, force=a.force)
    print(f"{n} file(s) written" if n else "everything up to date")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="doc-kit", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("serve", help="serve a talk locally (live reload)")
    p.add_argument("talk")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("-v", "--verbose", action="store_true")
    p.set_defaults(func=cmd_serve)

    p = sub.add_parser("build", help="standalone folder and/or PDF")
    p.add_argument("talk")
    p.add_argument("-o", "--out", help="output folder (default: <talk dir>/build/<name>)")
    p.add_argument("--pdf", action="store_true", help="also write a PDF")
    p.add_argument("--no-html", action="store_true", help="PDF only")
    p.add_argument("--steps", action="store_true", help="PDF: one page per step")
    p.add_argument("--theme", default="light", choices=["light", "dark"])
    p.set_defaults(func=cmd_build)

    p = sub.add_parser("pdf", help="export a talk to PDF")
    p.add_argument("talk")
    p.add_argument("-o", "--out")
    p.add_argument("--steps", action="store_true")
    p.add_argument("--theme", default="light", choices=["light", "dark"])
    p.set_defaults(func=cmd_pdf)

    p = sub.add_parser("check", help="render every slide and step headless and report problems")
    p.add_argument("talk")
    p.add_argument("--themes", default="light,dark")
    p.add_argument("--shots", help="screenshot folder")
    p.add_argument("--all-steps", action="store_true")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("packs", help="list the packs doc-kit can find")
    p.set_defaults(func=cmd_packs)

    p = sub.add_parser("math-check", help="check math assets in KaTeX and LaTeX")
    p.add_argument("packs", nargs="*", help="pack names or paths (default: all)")
    p.set_defaults(func=cmd_math_check)

    p = sub.add_parser("sty", help="LaTeX package for a pack's math assets")
    p.add_argument("pack")
    p.add_argument("--bundle", help="write a self-contained copy into this folder")
    p.add_argument("--root", help="path the package uses to find the pack")
    p.set_defaults(func=cmd_sty)

    p = sub.add_parser("graphics", help="export .mmd/.svg diagrams to .svg/.pdf")
    p.add_argument("paths", nargs="+")
    p.add_argument("--theme", default="light", choices=["light", "dark"])
    p.add_argument("--force", action="store_true")
    p.set_defaults(func=cmd_graphics)

    a = ap.parse_args(argv)
    a.func(a)


if __name__ == "__main__":
    main()
