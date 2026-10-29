"""Plots from W&B CSV exports, styled by an asset pack, saved for slides (SVG) and papers (PDF).

    from doc_kit import plots

    plots.use_style("example")                               # a pack name or path: fonts, palette, line widths
    fig, ax = plots.plot_runs(["data/gs_l2.csv"], key="l2_error_u", log=True)
    plots.save(fig, "figures/gs_l2")                         # figures/gs_l2.svg + figures/gs_l2.pdf

Slides embed the SVG (`::: figure src=figures/gs_l2.svg`); papers use
`\\includegraphics{figures/gs_l2.pdf}`. Both come from the same call.

The slide SVG has a transparent background and its text and axis labels are drawn in
`currentColor`, so an SVG inlined into a slide follows the light/dark theme. The PDF
keeps the style's ink colours on white.
"""
from __future__ import annotations

import csv
import math
import os
import pathlib
import re
from typing import Iterable, Mapping, Sequence

import matplotlib
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager

__all__ = ["use_style", "read_csv", "find_columns", "plot_runs", "save"]


def use_style(pack: str) -> pathlib.Path:
    """Apply a pack's matplotlib style (and register the pack's TTF/OTF fonts). Returns the style path.

    `pack` is a name (found on DOCKIT_PACKS or among the packs shipped with doc-kit) or a path.
    """
    from .packs import find_pack, load_config
    pack_dir = find_pack(pack)
    style = load_config(pack_dir).get("matplotlib")
    if not style:
        raise ValueError(f"pack {pack!r} has no `matplotlib:` style in pack.yaml")
    for font in sorted(pack_dir.rglob("*")):
        if font.suffix.lower() in (".ttf", ".otf"):
            font_manager.fontManager.addfont(str(font))
    path = pack_dir / style
    plt.style.use(str(path))
    return path


def read_csv(path: str | os.PathLike) -> dict[str, np.ndarray]:
    """Read a CSV into {column: float array}; empty cells become NaN."""
    with open(path, newline="") as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]

    def num(v: str) -> float:
        try:
            return float(v)
        except ValueError:
            return math.nan

    return {h: np.array([num(r[i]) if i < len(r) else math.nan for r in body]) for i, h in enumerate(header)}


def find_columns(columns: Iterable[str], key: str) -> list[str]:
    """Columns for metric `key`: an exact name, or W&B's `<run> - <key>`, or a unique substring.

    W&B's `__MIN` / `__MAX` / `_step` companions are never returned.
    """
    cols = [c for c in columns if not re.search(r"(__MIN|__MAX|_step)$", c)]
    if key in cols:
        return [key]
    runs = [c for c in cols if c.endswith(f" - {key}")]
    return runs or [c for c in cols if key in c]


def _ema(y: np.ndarray, alpha: float) -> np.ndarray:
    out = np.empty_like(y)
    acc = math.nan
    for i, v in enumerate(y):
        acc = v if math.isnan(acc) else alpha * acc + (1 - alpha) * v
        out[i] = acc
    return out


def plot_runs(
    csv_files: str | os.PathLike | Sequence[str | os.PathLike],
    key: str,
    *,
    x: str = "Step",
    log: bool = False,
    labels: Mapping[str, str] | None = None,
    smooth: float | None = None,
    band: bool = True,
    ax: plt.Axes | None = None,
    title: str | None = None,
    xlabel: str | None = None,
    ylabel: str | None = None,
):
    """One line per run for metric `key`, from one or more W&B CSV exports.

    - Every column matching `key` (see `find_columns`) becomes a line, labelled with its
      run name (the part before " - "), or `labels[run]` if given.
    - `__MIN` / `__MAX` companions are drawn as a band (turn off with band=False).
    - `smooth` is an EMA factor in [0, 1), like W&B's smoothing slider.
    Returns (fig, ax).
    """
    files = [csv_files] if isinstance(csv_files, (str, os.PathLike)) else list(csv_files)
    if ax is None:
        fig, ax = plt.subplots()
    else:
        fig = ax.figure
    labels = dict(labels or {})
    drawn = 0
    for path in files:
        table = read_csv(path)
        xs_key = x if x in table else next((c for c in table if c.lower() in ("step", "_step")), None)
        if xs_key is None:
            raise KeyError(f"{path}: no x column {x!r}")
        cols = find_columns(table, key)
        if not cols:
            raise KeyError(f"{path}: no column matching {key!r} (columns: {', '.join(table)})")
        for col in cols:
            xs, ys = table[xs_key], table[col]
            ok = ~np.isnan(xs) & ~np.isnan(ys) & ((ys > 0) if log else True)
            order = np.argsort(xs[ok])
            xv, yv = xs[ok][order], ys[ok][order]
            if smooth:
                yv = _ema(yv, smooth)
            run = col[: -len(f" - {key}")] if col.endswith(f" - {key}") else (pathlib.Path(path).stem if len(cols) == 1 else col)
            (line,) = ax.plot(xv, yv, label=labels.get(run, run))
            lo, hi = f"{col}__MIN", f"{col}__MAX"
            if band and lo in table and hi in table:
                lv, hv = table[lo][ok][order], table[hi][ok][order]
                ax.fill_between(xv, lv, hv, color=line.get_color(), alpha=0.12, linewidth=0)
            drawn += 1
    if log:
        ax.set_yscale("log")
    ax.set_xlabel(xlabel if xlabel is not None else x.lower())
    ax.set_ylabel(ylabel if ylabel is not None else key)
    if title:
        ax.set_title(title)
    if drawn > 1:
        ax.legend()
    return fig, ax


def _ink_colours() -> set[str]:
    """Hex colours the style uses for text (to become currentColor in slide SVGs)."""
    rc = matplotlib.rcParams
    out = set()
    for k in ("text.color", "axes.labelcolor", "axes.titlecolor", "xtick.labelcolor", "ytick.labelcolor"):
        v = rc.get(k)
        if v and v not in ("inherit", "auto"):
            out.add(matplotlib.colors.to_hex(v).lower())
    return out


def _rule_colours() -> dict[str, float]:
    """Hex colours of grid lines, spines and ticks, with the opacity they get in slide SVGs."""
    rc = matplotlib.rcParams
    out = {}
    for k, alpha in (("grid.color", 0.16), ("axes.edgecolor", 0.45), ("xtick.color", 0.45), ("ytick.color", 0.45)):
        v = rc.get(k)
        if v and v not in ("inherit", "auto"):
            out.setdefault(matplotlib.colors.to_hex(v).lower(), alpha)
    return out


def save(fig, name: str | os.PathLike, *, formats: Sequence[str] = ("svg", "pdf"), close: bool = True) -> list[pathlib.Path]:
    """Write `name.svg` (for slides) and `name.pdf` (for papers). Returns the paths written."""
    base = pathlib.Path(name)
    if base.suffix in (".svg", ".pdf", ".png"):
        base = base.with_suffix("")
    base.parent.mkdir(parents=True, exist_ok=True)
    written = []
    for fmt in formats:
        out = base.with_suffix(f".{fmt}")
        if fmt == "svg":
            fig.savefig(out, format="svg", transparent=True)
            text = out.read_text()
            # Theme-following slide SVG: rules become translucent currentColor, text becomes currentColor.
            for hexcol, alpha in _rule_colours().items():
                text = re.sub(rf"stroke:\s*{re.escape(hexcol)}", f"stroke: currentColor; stroke-opacity: {alpha}", text, flags=re.I)
            for hexcol in _ink_colours():
                text = re.sub(re.escape(hexcol), "currentColor", text, flags=re.I)
            out.write_text(text)
        else:
            fig.savefig(out, format=fmt)
        written.append(out)
    if close:
        plt.close(fig)
    return written
