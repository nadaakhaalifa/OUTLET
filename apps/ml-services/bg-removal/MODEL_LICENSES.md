# Model and dependency licences

Status: research summary, not legal advice. Every row that says "open" is a `VERIFY BEFORE LAUNCH` item in
`docs/compliance/verify-register.md` (VR-P3-BG-*). Archive each upstream LICENSE file at the pinned release
before enabling `kill.background_removal`.

## Allow-list (the only models the sidecar will load)

| Model name | Architecture | Code licence | Weights licence | Training data | Status |
|---|---|---|---|---|---|
| `u2netp` | U2-Net small (4.7 MB) | Apache-2.0 (xuebinqin/U-2-Net) | Apache-2.0, same repository | DUTS-TR (terms open, VR-P3-BG-03) | usable, pending VR-P3-BG-01/03 |
| `u2net` | U2-Net (176 MB) | Apache-2.0 | Apache-2.0, same repository | DUTS-TR (VR-P3-BG-03) | usable, pending VR-P3-BG-01/03 |
| `isnet-general-use` | IS-Net, DIS | Apache-2.0 (xuebinqin/DIS) | **Not explicit** (VR-P3-BG-02) | DIS5K (VR-P3-BG-03) | **counsel decision before use** |
| `birefnet-general-lite` | BiRefNet, Swin-tiny | MIT (ZhengPeng7/BiRefNet) | MIT, same repository | DIS5K, DUTS and others (VR-P3-BG-03) | usable, pending VR-P3-BG-01/03 |

Runtime: `rembg` (MIT, danielgatis/rembg) and `onnxruntime` (MIT). rembg only packages and downloads the
models above; its own code licence does not extend to model weights.

## Excluded on purpose

| Model | Why |
|---|---|
| BRIA RMBG-1.4, RMBG-2.0 | Non-commercial licence (commercial use needs a BRIA agreement). Never add to `ALLOWED_MODELS` or `models.lock.json`; the API refuses the names with 422 `unknown_model` (tested). |
| remove.bg, PhotoRoom, Clipdrop, Cloudinary AI | Hosted APIs: not free at volume, and they send seller images out of the region. Not the default. Any such adapter must be an optional `BackgroundRemovalPort` implementation with `residency: "external"`, left Unconfigured, behind the `cross_border_ml` consent and a transfer licence (ADR-0002, VR-P3-BG-06). |

## Open licence questions

1. **IS-Net weights (VR-P3-BG-02).** The repository states Apache-2.0 for code. The released checkpoint file has no separate licence text. Until counsel decides, treat `isnet-general-use` as not cleared for production.
2. **Training-data terms (VR-P3-BG-03).** DIS5K and DUTS are research datasets. A permissive model licence does not, by itself, settle whether dataset terms reach derived weights. This affects every model above equally, so it is a launch gate for the whole feature, not a reason to prefer one model.
3. **Checkpoint integrity (VR-P3-BG-04).** `models.lock.json` has `sha256: null` for all models. Nothing was downloaded or hashed when this was written, and no hash was invented. The Docker build fails on a null hash unless `ALLOW_UNPINNED_MODELS=1`.

## Recommendation (until the benchmark has real photos)

Start the benchmark with `u2netp` (smallest, fastest, Apache-2.0 end to end) as the provisional default and
compare `birefnet-general-lite` (MIT, expected best edges, slowest on CPU) against it. Keep `isnet-general-use`
out of production until VR-P3-BG-02 is answered. Choose the default from the benchmark CSV, not from this table.
