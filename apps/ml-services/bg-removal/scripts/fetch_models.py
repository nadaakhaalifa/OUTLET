"""Downloads the allow-listed model files at image build time and verifies their SHA-256.

Usage:
  python scripts/fetch_models.py --dest /opt/models            # fails when a hash is not pinned
  python scripts/fetch_models.py --dest /tmp/m --print-hashes  # prints hashes to paste into models.lock.json
  ALLOW_UNPINNED_MODELS=1 python scripts/fetch_models.py ...   # build with unpinned hashes (never for production)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.request
from pathlib import Path
from typing import Any

LOCK = Path(__file__).resolve().parent.parent / "models.lock.json"
ALLOWED_HOSTS = ("github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com")


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def fetch(url: str, dest: Path) -> None:
    if not url.startswith("https://") or url.split("/")[2] not in ALLOWED_HOSTS:
        raise SystemExit(f"refusing to download from {url}")
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as r, tmp.open("wb") as f:  # noqa: S310  (https and host allow-listed above)
        while True:
            block = r.read(1 << 20)
            if not block:
                break
            f.write(block)
    tmp.replace(dest)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dest", required=True)
    ap.add_argument("--print-hashes", action="store_true")
    ap.add_argument("--models", nargs="*", default=None)
    args = ap.parse_args()
    lock: dict[str, Any] = json.loads(LOCK.read_text())
    unpinned_ok = os.environ.get("ALLOW_UNPINNED_MODELS") == "1" or args.print_hashes
    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)
    bad = 0
    for name, spec in lock["models"].items():
        if args.models and name not in args.models:
            continue
        target = dest / spec["file"]
        fetch(spec["url"], target)
        digest = sha256_of(target)
        pinned = spec["sha256"]
        if pinned is None:
            print(f"{name}: sha256 {digest} (NOT PINNED)")
            if not unpinned_ok:
                bad += 1
        elif pinned != digest:
            print(f"{name}: CHECKSUM MISMATCH expected {pinned} got {digest}", file=sys.stderr)
            bad += 1
        else:
            print(f"{name}: ok {digest}")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
