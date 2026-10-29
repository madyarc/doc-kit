"""Figures for the example deck, from the CSVs in data/. Run: python3 talks/example/make_figures.py

Each figure is written twice by one call: figures/<name>.svg for the slides and
figures/<name>.pdf for a paper.
"""
import pathlib

from doc_kit import plots

HERE = pathlib.Path(__file__).resolve().parent

plots.use_style("example")
fig, ax = plots.plot_runs(HERE / "data/loss.csv", key="loss", log=True, labels={"baseline": "Baseline", "ours": "Ours"})
for path in plots.save(fig, HERE / "figures/loss"):
    print(f"wrote {path.relative_to(HERE)}")
