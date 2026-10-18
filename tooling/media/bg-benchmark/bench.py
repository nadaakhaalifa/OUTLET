#!/usr/bin/env python3
"""Background-removal benchmark: runs candidate models over a folder of garment photos.

Standard library only. It talks to the sidecar over HTTP (apps/ml-services/bg-removal), so the models are
exactly the ones that would run in production. For every image and model it writes the transparent cutout,
the white-background JPG and one CSV row (quality score, reasons, mask statistics, latency).

  python bench.py --smooth 0 0.5 ...   # A/B the matte refinement (0 = off); models may be quality=fast|high
  python bench.py --input ./photos --out ./out --url http://127.0.0.1:8080 \
      --models u2netp u2net isnet-general-use birefnet-general-lite

Category = first sub-folder name under --input (hanger, flat_lay, ghost_mannequin, white_on_white,
dark_on_dark), else "uncategorized". Quality scores are mask statistics, NOT a visual verdict: always look at
the PNGs. Needs ~50 real photos supplied by the owner before a default model is chosen (see README.md).
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

from edge_metrics import compute as edge_metrics
from quality import READY_THRESHOLD, assess, is_ready

EXTS = {".jpg", ".jpeg", ".png", ".webp"}
FIELDS = [
    "file", "category", "model", "http_status", "latency_ms", "wall_ms", "score", "ready", "reasons",
    "coverage", "border_touch", "components", "hole_ratio", "soft_edge_ratio", "subject_bright_ratio",
    "border_bright_ratio", "png_bytes", "halo_dist", "edge_jaggies", "specks", "error",
]


def cutout(
    url: str, model: str, data: bytes, timeout: float, smooth: float | None = None, edge_shift: float | None = None
) -> tuple[int, dict[str, Any] | None, str]:
    """`model` may also be `quality=fast` or `quality=high` to use the server-side model mapping."""
    sel = model if model.startswith("quality=") else f"model={model}"
    extra = ""
    if smooth is not None:
        extra += f"&smooth={smooth}"
    if edge_shift is not None:
        extra += f"&edge_shift_px={edge_shift}"
    req = urllib.request.Request(
        f"{url.rstrip('/')}/v1/cutout?{sel}&shadow=false{extra}",
        data=data,
        method="POST",
        headers={"content-type": "application/octet-stream"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:  # noqa: S310  (operator-supplied internal URL)
            return r.status, json.loads(r.read().decode("utf-8")), ""
    except urllib.error.HTTPError as e:
        return e.code, None, e.read(500).decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, None, str(e)


def discover(root: Path) -> list[tuple[Path, str]]:
    out: list[tuple[Path, str]] = []
    for p in sorted(root.rglob("*")):
        if p.suffix.lower() in EXTS and p.is_file():
            rel = p.relative_to(root)
            out.append((p, rel.parts[0] if len(rel.parts) > 1 else "uncategorized"))
    return out


def run(args: argparse.Namespace) -> int:
    root, out = Path(args.input), Path(args.out)
    images = discover(root)
    if not images:
        print(f"no images found under {root}", file=sys.stderr)
        return 2
    out.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for path, category in images:
        data = path.read_bytes()
        for base_model, sm in [(m, s) for m in args.models for s in (args.smooth or [None])]:
            model = base_model if sm is None else f"{base_model}@s{sm}"
            t0 = time.perf_counter()
            status, body, err = cutout(args.url, base_model, data, args.timeout, sm, args.edge_shift)
            wall = int((time.perf_counter() - t0) * 1000)
            row: dict[str, Any] = {"file": str(path.relative_to(root)), "category": category, "model": model, "http_status": status, "wall_ms": wall, "error": err}
            if body is not None:
                s = body["stats"]
                score, reasons, _ = assess(s)
                png = base64.b64decode(body["png_b64"])
                stem = f"{path.stem}.{model}"
                (out / f"{stem}.png").write_bytes(png)
                (out / f"{stem}.white.jpg").write_bytes(base64.b64decode(body["white_jpg_b64"]))
                row.update(
                    latency_ms=body["latency_ms"], score=score, ready=is_ready(score, reasons), reasons="|".join(reasons),
                    coverage=round(s["coverage"], 4), border_touch=round(s["border_touch"], 4), components=s["components"],
                    hole_ratio=round(s["hole_ratio"], 4), soft_edge_ratio=round(s["soft_edge_ratio"], 4),
                    subject_bright_ratio=round(s["subject_bright_ratio"], 4), border_bright_ratio=round(s["border_bright_ratio"], 4),
                    png_bytes=len(png),
                )
                row.update(edge_metrics(png))
            rows.append(row)
            print(f"{row['file']:40} {model:22} {status} {row.get('score', '-')!s:>4} {row.get('latency_ms', '-')!s:>6} ms")
    with (out / "results.csv").open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)
    summary(rows, out / "summary.csv")
    return 0


def summary(rows: list[dict[str, Any]], path: Path) -> None:
    head = ["model", "category", "n", "ok", "mean_score", "pct_ready", "p50_ms", "p95_ms"]
    groups: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for r in rows:
        groups.setdefault((r["model"], "ALL"), []).append(r)
        groups.setdefault((r["model"], r["category"]), []).append(r)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(head)
        for (model, cat), g in sorted(groups.items()):
            ok = [r for r in g if "score" in r]
            lat = sorted(r["latency_ms"] for r in ok)
            p95 = lat[min(len(lat) - 1, int(0.95 * len(lat)))] if lat else ""
            w.writerow([
                model, cat, len(g), len(ok),
                round(statistics.mean(r["score"] for r in ok), 1) if ok else "",
                round(100 * sum(1 for r in ok if r["ready"]) / len(ok), 1) if ok else "",
                int(statistics.median(lat)) if lat else "", p95,
            ])
    print(f"wrote {path} (READY threshold {READY_THRESHOLD})")


def selftest() -> int:
    cases = json.loads((Path(__file__).parent / "fixtures" / "quality-cases.json").read_text())
    bad = 0
    for c in cases["cases"]:
        score, reasons, _ = assess(c["stats"])
        if score != c["score"] or reasons != c["reasons"]:
            print(f"MISMATCH {c['name']}: got {score} {reasons}, want {c['score']} {c['reasons']}", file=sys.stderr)
            bad += 1
    print("selftest ok" if not bad else f"selftest FAILED ({bad})")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--input")
    ap.add_argument("--out")
    ap.add_argument("--url", default="http://127.0.0.1:8080")
    ap.add_argument("--models", nargs="+", default=["u2netp", "u2net", "isnet-general-use", "birefnet-general-lite"])
    ap.add_argument("--smooth", type=float, nargs="+", help="smooth values 0..1; several = A/B (e.g. 0 0.5)")
    ap.add_argument("--edge-shift", type=float, help="edge_shift_px -3..3")
    ap.add_argument("--timeout", type=float, default=60.0)
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args()
    if a.selftest:
        return selftest()
    if not a.input or not a.out:
        ap.error("--input and --out are required")
    return run(a)


if __name__ == "__main__":
    raise SystemExit(main())
