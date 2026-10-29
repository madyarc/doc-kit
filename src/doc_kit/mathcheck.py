"""Check that every math asset of a pack compiles in both KaTeX (slides) and LaTeX (papers).

Every math/**/*.tex asset (except the macros file) is checked with its default parameters, plus
any parameter sets listed on a `% check:` line in the asset (e.g. `% check: pde=kdv; pde=gs`).
KaTeX: expanded as the slides do it and rendered in strict mode in headless Firefox.
LaTeX: one document with every asset in an `equation` (with \\label/\\eqref), compiled with
pdflatex; skipped with a note if pdflatex is not installed.
"""
from __future__ import annotations

import os
import pathlib
import re
import shutil
import subprocess
import tempfile

from . import packs as packs_mod
from . import server
from .browser import firefox, wait_for
from .sty import build_sty


def items_for(pack_dir, cfg):
    math_dir = pack_dir / cfg.get("math", "math")
    macros = (pack_dir / cfg["macros"]).resolve() if isinstance(cfg.get("macros"), str) else None
    items = []
    for tex in sorted(math_dir.rglob("*.tex")):
        if macros and tex.resolve() == macros:
            continue
        name = tex.relative_to(math_dir).with_suffix("").as_posix()
        items.append((name, {}))
        for line in tex.read_text().splitlines():
            m = re.match(r"\s*%\s*check:\s*(.*)$", line)
            if m:
                for variant in filter(None, (v.strip() for v in m.group(1).split(";"))):
                    items.append((name, dict(kv.strip().split("=", 1) for kv in variant.split(","))))
    return items


def check_katex(driver, base, name, cfg, items):
    driver.get(f"{base}_dk/engine/tools/check_math.html")
    wait_for(driver, "checkReady")
    args = {
        "mathUrl": f"{base}_dk/assets/{name}/{cfg.get('math', 'math')}/",
        "macrosUrl": f"{base}_dk/assets/{name}/{cfg['macros']}" if isinstance(cfg.get("macros"), str) else None,
        "prefix": (cfg.get("latex") or {}).get("prefix", name),
        "items": [{"name": n, "params": p} for n, p in items],
    }
    return driver.execute_async_script(
        "const done = arguments[1]; checkMath(arguments[0]).then(done, (e) => done([{name: '*', ok: false, error: String(e)}]))", args)


def check_latex(pack_dir, cfg, items):
    if not shutil.which("pdflatex"):
        return None
    prefix = cfg["latex"]["prefix"]
    body = []
    for k, (name, params) in enumerate(items):
        opt = "[" + ",".join(f"{a}={b}" for a, b in params.items()) + "]" if params else ""
        body.append(f"\\typeout{{doc-kit item {k}:}}\n\\begin{{equation}}\n\\{prefix}asset{opt}{{{name}}}\\label{{eq:{k}}}\n\\end{{equation}}\nSee~\\eqref{{eq:{k}}}.\n")
    doc = ("\\documentclass{article}\n\\usepackage[a3paper,landscape,margin=1cm]{geometry}\n\\usepackage{" + prefix + "}\n"
           "\\begin{document}\n" + "\n".join(body) + "\\end{document}\n")
    failures = []
    with tempfile.TemporaryDirectory() as tmp:
        sty = build_sty(pack_dir, bundle=pathlib.Path(tmp) / "pkg", root=(pathlib.Path(pack_dir).as_posix() + "/"))
        (pathlib.Path(tmp) / "check.tex").write_text(doc)
        env = {**os.environ, "TEXINPUTS": f"{sty.parent}//:"}
        for _ in range(2):  # twice, so \eqref resolves
            proc = subprocess.run(["pdflatex", "-interaction=nonstopmode", "check.tex"], cwd=tmp, env=env, capture_output=True, text=True)
        log = (pathlib.Path(tmp) / "check.log").read_text(errors="replace")
        current = None
        for line in log.splitlines():
            m = re.search(r"doc-kit item (\d+):", line)
            if line.startswith("!"):
                failures.append((current, line))
            elif m:
                current = int(m.group(1))
        if proc.returncode and not failures:
            failures.append((None, f"pdflatex exited with {proc.returncode}"))
        for line in re.findall(r"LaTeX Warning: Reference .* undefined.*", log):
            failures.append((None, line))
    return [(items[i] if i is not None else ("*", {}), msg) for i, msg in failures]


def check_packs(specs=(), out=print) -> int:
    targets = {}
    for spec in specs or packs_mod.all_packs():
        d = packs_mod.find_pack(spec)
        targets[d.name] = d
    targets = {n: d for n, d in targets.items() if (d / packs_mod.load_config(d).get("math", "math")).is_dir()}
    srv, base = server.start(packs=targets)
    driver = firefox()
    failed = 0
    try:
        for name, d in targets.items():
            cfg = packs_mod.load_config(d)
            items = items_for(d, cfg)
            out(f"{name}: {len(items)} math checks ({len({n for n, _ in items})} assets)")
            for r in check_katex(driver, base, name, cfg, items):
                if not r["ok"]:
                    failed += 1
                    out(f"  katex FAIL {r['name']} {r.get('params') or ''}: {r['error']}")
            if not (cfg.get("latex") or {}).get("prefix"):
                continue
            res = check_latex(d, cfg, items)
            if res is None:
                out("  latex: pdflatex not found, skipped")
                continue
            for (n, params), msg in res:
                failed += 1
                out(f"  latex FAIL {n} {params or ''}: {msg}")
    finally:
        driver.quit()
        srv.shutdown()
    return failed
