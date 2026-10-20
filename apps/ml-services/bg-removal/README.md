# bg-removal sidecar

Self-hosted background removal for seller product photos: FastAPI + rembg + onnxruntime (CPU). Called by
`apps/api/src/modules/product-media` over an internal, allow-listed URL (`RembgHttpBackgroundRemoval`). It
holds no state, stores nothing and logs no image content.

## API

- `GET /healthz` -> `{status, models_available, default_model}`
- `POST /v1/cutout?model=&feather_px=1.5&padding_ratio=0.06&white_max_side=1600&shadow=true`
  Body: raw image bytes (jpeg, png or webp, at most 12 MB and 4096 px per side).
  Returns JSON: `png_b64` (cleaned, cropped RGBA), `mask_b64`, `white_jpg_b64`, `shadow_png_b64`, `stats`
  (coverage, border_touch, components, hole_ratio, soft_edge_ratio, subject_bright_ratio, border_bright_ratio),
  `model_id`, `model_version`, `latency_ms`.
  Errors: 413 too large, 422 unsupported/malformed/too many pixels/unknown model, 429 busy, 503 model not
  installed, 504 timeout.

Post-processing (in `app/processing.py`, pure numpy): speck removal, 1-2 px boundary feather, edge colour
decontamination (nearest solid interior colour), crop to subject with padding, white-background JPG
(downscale only), optional soft ground shadow. Upload hardening (`app/ingest.py`): magic-byte sniff (declared type ignored), header-only size/pixel caps (4096 px per side,
24 Mpx, `BG_MAX_PIXELS`), animated formats rejected, EXIF orientation applied, then the embedded ICC profile (for example
Display P3) is converted to sRGB (missing profile = sRGB; malformed profile = 422) before pixels are re-encoded, so no
EXIF, GPS or ICC metadata survives. The caller keeps the untouched original. Responses add `edit_label`
(`background_replaced` or `composited`, computed in `app/labels.py`), `icc_source` and `studio_eligible` (long side >= 800 px).
Colour/structure gate primitives (CIEDE2000, SSIM, placeholder thresholds, VERIFY VR-STUDIO-05) live in `app/colour.py`.

## Build and run

```
# 1. pin the model hashes once, on the build host (downloads from the official release URLs)
python scripts/fetch_models.py --dest /tmp/models --print-hashes     # paste into models.lock.json, review
# 2. build (fails while any hash is null)
docker build -t outlet/bg-removal apps/ml-services/bg-removal
# 3. run: no secrets, no volumes, read-only root, non-root user
docker run --rm --read-only --tmpfs /tmp -p 127.0.0.1:8080:8080 outlet/bg-removal
```

Models are baked into the image under `/opt/models` (`U2NET_HOME`); the process never downloads anything.
Deploy with an **egress-deny** network policy (the service needs ingress from the API only), for example in
Kubernetes a `NetworkPolicy` with `policyTypes: [Egress]` and no egress rules, and ingress limited to the API pods.
Set `BG_REMOVAL_ALLOWED_HOSTS`-style allow-listing on the API side by passing `allowedHosts` to the adapter.

## Run locally (macOS)

```
tooling/media/run-sidecar.sh            # from the repo root; Ctrl-C stops it
```

The script is idempotent. It creates `apps/ml-services/bg-removal/.venv` with the newest Python 3.12 or 3.13 it
finds, installs `requirements.txt` (`--default-timeout=180 --retries 8`), fetches `u2netp` into `.models` with
`ALLOW_UNPINNED_MODELS=1` (local development only; it prints the measured SHA-256 so you can review it), and starts
`uvicorn app.main:factory --factory` on `127.0.0.1:8099` with `U2NET_HOME=.models` and `BG_DEFAULT_MODEL=u2netp`.
Check it with `curl http://127.0.0.1:8099/healthz`.

To use it from the mobile app in development, add to `apps/mobile/.env.local` (see `apps/mobile/.env.example`):

```
EXPO_PUBLIC_DEV_CUTOUT_URL=http://127.0.0.1:8099
```

and restart Expo with `npx expo start -c`. The URL is used only in a development build with no
`EXPO_PUBLIC_API_BASE_URL`, and only for `http://127.0.0.1`, `localhost`, `10.x.x.x` or `192.168.x.x`. On a physical
phone use your Mac's LAN address (the script binds to 127.0.0.1; set up a tunnel or change the host yourself).

Python 3.13 works locally; the container image stays on 3.12 (`pyproject.toml` allows `>=3.12,<3.14`).

## Dev checks (not run in the authoring session: python deps were not installed)

```
python -m venv .venv && . .venv/bin/activate && pip install -e '.[dev]'
ruff check . && mypy --strict . && pytest
```

`tests/` use a fake matter (no model, no network): edge cleanup on synthetic masks, derivatives, API limits,
the allow-list.

## Config (env)

`BG_DEFAULT_MODEL` (u2netp), `BG_MAX_REQUEST_BYTES` (12 MiB), `BG_MAX_DIMENSION` (4096), `BG_TIMEOUT_SECONDS` (25),
`BG_MAX_CONCURRENCY` (2), `U2NET_HOME` (/opt/models).

Licences and open questions: `MODEL_LICENSES.md`.
