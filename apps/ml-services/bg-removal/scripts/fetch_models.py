"""Downloads the allow-listed model files at image build time and verifies their SHA-256.

Usage:
  python scripts/fetch_models.py --dest /opt/models            # fails when a hash is not pinned
  python scripts/fetch_models.py --dest /tmp/m --print-hashes  # prints hashes to paste into models.lock.json
  ALLOW_UNPINNED_MODELS=1 python scripts/fetch_models.py ...   # unpinned build, never for prod
"""

from __future__ import annotations

import argparse
import hashlib
import http.client
import json
import os
import ssl
import sys
import urllib.parse
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


MAX_REDIRECTS = 5


def _https_target(url: str) -> tuple[str, str]:
    """Returns (host, path-with-query) for an https URL on an allow-listed host, else exits."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname not in ALLOWED_HOSTS or parts.port not in (None, 443):
        raise SystemExit(f"refusing to download from {url}")
    return parts.hostname, parts.path + (f"?{parts.query}" if parts.query else "")


def fetch(url: str, dest: Path) -> None:
    """HTTPS-only download via http.client (no urllib opener, so no file:// or other schemes).

    Redirects are followed manually and every hop is re-checked against ALLOWED_HOSTS.
    """
    tmp = dest.with_suffix(dest.suffix + ".part")
    for _ in range(MAX_REDIRECTS + 1):
        host, target = _https_target(url)
        conn = http.client.HTTPSConnection(host, timeout=120, context=ssl.create_default_context())
        try:
            conn.request("GET", target, headers={"User-Agent": "outlet-fetch-models"})
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308):
                location = r.getheader("Location")
                if not location:
                    raise SystemExit(f"redirect without Location from {host}")
                url = urllib.parse.urljoin(url, location)
                continue
            if r.status != 200:
                raise SystemExit(f"download failed: HTTP {r.status} from {host}")
            with tmp.open("wb") as f:
                while True:
                    block = r.read(1 << 20)
                    if not block:
                        break
                    f.write(block)
        finally:
            conn.close()
        tmp.replace(dest)
        return
    raise SystemExit("too many redirects")


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
