"""Asset packs: where they are and how a talk names them.

A pack is a folder with a pack.yaml. A talk selects one in its front matter:

    pack: example            # a name: looked up in $DOCKIT_PACKS, then in the packs shipped with doc-kit
    pack: ../../packs/mylab  # a path: relative to the talk file (or absolute, or ~/...)

DOCKIT_PACKS is a list of folders separated by ':' (';' on Windows). Each entry is either a
pack folder itself (it has pack.yaml) or a folder whose sub-folders are packs. Earlier entries win.
"""
from __future__ import annotations

import os
import pathlib
import re

import yaml

BUILTIN = pathlib.Path(__file__).resolve().parent / "packs"


def _entries():
    for part in filter(None, os.environ.get("DOCKIT_PACKS", "").split(os.pathsep)):
        yield pathlib.Path(part).expanduser().resolve()


def all_packs() -> dict[str, pathlib.Path]:
    """name -> folder for every pack on DOCKIT_PACKS and in doc-kit itself (DOCKIT_PACKS first)."""
    found: dict[str, pathlib.Path] = {}
    for root in [*_entries(), BUILTIN]:
        if (root / "pack.yaml").is_file():
            found.setdefault(root.name, root)
        elif root.is_dir():
            for sub in sorted(root.iterdir()):
                if (sub / "pack.yaml").is_file():
                    found.setdefault(sub.name, sub)
    return found


def is_path(spec: str) -> bool:
    return any(c in spec for c in "/\\") or spec.startswith(("~", "."))


def find_pack(spec: str, base: str | os.PathLike | None = None) -> pathlib.Path:
    """Resolve a pack name or path (paths relative to `base`, usually the talk's folder)."""
    if is_path(spec):
        p = pathlib.Path(spec).expanduser()
        if not p.is_absolute():
            p = pathlib.Path(base or ".").resolve() / p
        p = p.resolve()
        if not (p / "pack.yaml").is_file():
            raise FileNotFoundError(f"no pack.yaml in {p}")
        return p
    packs = all_packs()
    if spec not in packs:
        raise FileNotFoundError(f"pack {spec!r} not found (searched DOCKIT_PACKS and {BUILTIN}); known: {', '.join(packs) or 'none'}")
    return packs[spec]


def pack_name(spec: str) -> str:
    """The name the engine uses for a pack spec: the last path segment."""
    return pathlib.PurePath(spec.rstrip("/\\")).name


def load_config(pack_dir: pathlib.Path) -> dict:
    return yaml.safe_load((pack_dir / "pack.yaml").read_text()) or {}


def front_matter(md_path: str | os.PathLike) -> dict:
    text = pathlib.Path(md_path).read_text()
    m = re.match(r"---\n(.*?)\n---[ \t]*(\n|$)", text.replace("\r\n", "\n"), re.S)
    return (yaml.safe_load(m.group(1)) or {}) if m else {}


def talk_packs(md_path: str | os.PathLike) -> dict[str, pathlib.Path]:
    """name -> folder for the packs a talk uses: its `pack:` plus any `::: use other:...` packs."""
    md_path = pathlib.Path(md_path).resolve()
    meta = front_matter(md_path)
    out: dict[str, pathlib.Path] = {}
    if meta.get("pack"):
        out[pack_name(str(meta["pack"]))] = find_pack(str(meta["pack"]), md_path.parent)
    for other in set(re.findall(r"^\s*:::\s*use\s+([\w-]+):", md_path.read_text(), re.M)):
        out.setdefault(other, find_pack(other))
    return out
