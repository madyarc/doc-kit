"""Render every slide and step of a talk headless, in both themes; report errors, overflow and pending data."""
from __future__ import annotations

import pathlib

from . import server
from .browser import firefox, open_deck


def check_talk(talk, themes=("light", "dark"), shots=None, all_steps=False, out=print) -> int:
    talk = pathlib.Path(talk).resolve()
    srv, base = server.start(talk)
    driver = firefox()
    problems, tbds = 0, set()
    try:
        for theme in themes:
            rep = open_deck(driver, f"{base}?theme={theme}&nowatch")
            for e in rep["errors"]:
                out(f"  [{theme}] ERROR {e}")
                problems += 1
            tbds.update(rep["tbds"])
            if not driver.execute_script("return typeof docKit.count === 'function'"):
                break
            n = driver.execute_script("return docKit.count()")
            total = 0
            for i in range(n):
                steps = driver.execute_script("return docKit.steps(arguments[0])", i)
                total += steps
                for s in (range(steps + 1) if all_steps else [steps]):
                    driver.execute_script("docKit.go(arguments[0], arguments[1])", i, s)
                    if shots:
                        d = pathlib.Path(shots) / talk.stem / theme
                        d.mkdir(parents=True, exist_ok=True)
                        driver.save_screenshot(str(d / (f"{i + 1:02d}.{s}.png" if all_steps else f"{i + 1:02d}.png")))
                for o in driver.execute_script("return docKit.overflow(arguments[0])", i):
                    where = ", ".join(f"{k} +{o[k]}px" for k in ("right", "bottom", "left") if o[k] > 2)
                    out(f"  [{theme}] OVERFLOW slide {i + 1} ({o['where']}): <{o['tag']}> {where}: {o['text']!r}")
                    problems += 1
            for e in driver.execute_script("return docKit.report.errors")[len(rep["errors"]):]:
                out(f"  [{theme}] ERROR {e}")
                problems += 1
            if theme == themes[0]:
                out(f"  {n} slides, {total} steps")
    finally:
        driver.quit()
        srv.shutdown()
    for t in sorted(tbds):
        out(f"  pending: {t}")
    return problems
