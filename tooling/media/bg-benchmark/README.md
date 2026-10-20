# Background-removal benchmark

Runs every candidate model over a folder of garment photos through the real sidecar, writes the cutouts and a
CSV of quality scores and latency, so the default model is chosen from evidence.

**Status: UNVERIFIED for garments.** Nothing here proves quality. Mask statistics find broken cutouts; they do
not replace looking at the PNGs.

## What the owner must supply

About **50 real product photos** of the kind sellers will upload, in sub-folders named after the case:

```
photos/hanger/            garment on a hanger
photos/flat_lay/          laid flat on a surface
photos/ghost_mannequin/   invisible mannequin
photos/white_on_white/    white garment on a white backdrop (the hard case)
photos/dark_on_dark/      black or navy garment on a dark backdrop
```

Aim for 8-12 per folder, mixed lighting and phone quality. Do not commit the photos (they are seller content).
`fixtures/synthetic/` (made by `make_fixtures.py`, no dependencies) only exercises the harness.

## Run

```
# sidecar running locally with the models installed (see apps/ml-services/bg-removal/README.md)
python bench.py --input ./photos --out ./out --url http://127.0.0.1:8080 \
    --models u2netp u2net isnet-general-use birefnet-general-lite
python bench.py --selftest        # checks quality.py against fixtures/quality-cases.json
```

Outputs: `out/<name>.<model>.png` (cutout), `out/<name>.<model>.white.jpg`, `out/results.csv` (one row per
image and model: score, READY flag, reasons, mask statistics, latency), `out/summary.csv` (per model and
category: mean score, % READY, p50 and p95 latency).

## Choosing the default

1. Open the PNGs for the white-on-white and dark-on-dark folders first; those decide the model.
2. Prefer the model with the highest share of READY cutouts that the reviewer agrees with, then lowest p95 latency
   on the target CPU. Record the decision in an ADR.
3. Tune `READY_THRESHOLD` (70) in `quality.ts` and `quality.py` together; `fixtures/quality-cases.json` is the
   parity fixture asserted by both. `isnet-general-use` stays out until VR-P3-BG-02 is answered.
