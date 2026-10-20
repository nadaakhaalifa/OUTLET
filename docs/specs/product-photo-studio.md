# Product photo studio: background removal, studio backgrounds, mannequin, hanger and flat-lay templates

- Status: **Spec (Proposed)**. Nothing in this document is built. Decision record: [ADR-0059](../adr/0059-product-photo-studio-mannequin.md) (Proposed).
- Date: 2026-10-18
- Master prompt refs: §19 (catalog: bulk images with automatic background cleanup), §27 (trust and safety, content, IP), §11 (item understanding reads product images), §T3 (ML services), §T5 (upload pipeline, SSRF, supply chain), §T10 (carbon and FinOps), §B1 (PDPL residency), §B5 (CPL 181/2018 not misleading), §B7 (Apple), A2.13 (never fake data).
- Builds on: `docs/specs/phase-3/product-media-background-removal.md` (cutout jobs, versions, refine, linking), `apps/ml-services/bg-removal` (sidecar, `MODEL_LICENSES.md`), `tooling/media/bg-benchmark`, `apps/mobile/src/features/background-removal` (cutout panel, editor, backdrops), `apps/mobile/src/features/brand-mode/photos.ts` and `cutout-link.ts`.
- Related ADRs: 0002 (residency), 0028 (kill-switch polarity), 0029 (Unconfigured fails closed), 0033 (Redis), 0051 (own AI, no external AI vendor), 0056 (seller plans and entitlements).
- VERIFY rows: VR-STUDIO-01..11 (new), VR-P3-BG-01..06, VR-AI-01, VR-AI-02, VR-AI-04, VR-18.

## 0. Owner request and how this spec reads it

Owner, verbatim intent: "I upload a t-shirt and it removes its background and maybe puts it on a mannequin too".

Reading: a seller photographs one garment (camera or gallery), the platform removes the background (already built), places the result on a clean studio background, and, optionally, presents it on a mannequin, hanger or flat-lay template that suits the garment category. The buyer must still see the real product: same colour, cut, print, length and fit. The original photo is always kept and the buyer can open it.

What is already built (read 2026-10-18): upload with signed PUT, EXIF/GPS strip and scan state; cutout jobs `PENDING -> PROCESSING -> READY | NEEDS_REVIEW | FAILED`; quality score with a READY threshold of 70 (parity between API, mobile and the benchmark); manual refine with brush strokes, feather, smooth and edge shift, kept as up to 5 immutable versions; white JPG and soft-shadow derivatives; seller decision `accepted | use_original`; attaching a decided job to a product; kill switch `kill.background_removal` (default blocked); per-store quota 200 runs per UTC day; Unconfigured provider in production. This spec adds the studio step **after** an accepted cutout. It does not change the cutout pipeline except for the upload hardening in section 3.

## 1. Decisions in one place

| Topic | Choice | Why (2-3 lines) | ADR |
|---|---|---|---|
| Mannequin step | **Deterministic template compositing with rigid transforms only** (uniform scale, small rotation, translation) onto mannequin, hanger, flat-lay or plinth templates. Ghost mannequin from two real shots is a later phase. Generative on-model is **not built**, kill switch permanently blocked until licence, honesty and residency rows close. | Every garment pixel shown is a pixel the seller photographed, so colour, print, cut and length cannot drift; it runs on CPU in milliseconds with no new model licence. Generative try-on invents detail by design, needs GPUs the region may not have (VR-AI-02), and the try-on models we know of are reported as non-commercial (VR-STUDIO-03). | 0059 |
| Where it runs | Server-side authoritative render in the bg-removal sidecar (new `/v1/compose` endpoint, same egress-deny pod); on-device only for a live preview of the same parameters. | One renderer gives reproducible, quality-gated output with a stored evidence trail; device rendering differs by OS version and cannot be audited. The preview reuses the existing `ArchStudio`/`Checkerboard` pattern and costs nothing. | 0059 |
| Job queue | Postgres table queue (`FOR UPDATE SKIP LOCKED` claim on `studio_renders`) driven by the outbox, not BullMQ. | Volume is low (thousands per day), the job row is already the state machine, and ADR-0033 keeps Redis off any source of truth; a Redis outage must not lose renders. Revisit if sustained throughput passes about 50 renders per second. | 0059 |
| Honesty | Original always retained and viewable by the buyer; every edited image carries a machine-readable `edit_label`; colour (CIEDE2000) and structure (SSIM) gates are hard gates. | A2.13 and CPL 181/2018 forbid misleading product presentation; whether a visible label is legally required is **not** decided here (VR-STUDIO-01), so the default shows one. | 0059 |
| Entitlements | New ADR-0056 keys under `media.*`; reads fail closed to the fallback plan. Existing 200 runs/day stays as an abuse ceiling for every plan. | Cost scales with renders; plan values are owner data, not code. | 0056, 0059 |

## 2. Flow (seller)

Entry points: Seller Center (web) catalog > product > Photos > "Studio"; mobile brand mode photo grid (`features/brand-mode`) > photo > "Studio".

1. **Capture or pick.** Camera or gallery (`pickPhotos`, multi-select up to the remaining slots, max 12 per product). The seller picks a **shot type** per photo: `flat_lay | hanger | mannequin | ghost_front | ghost_inner | on_model | detail`. Default `flat_lay`. Optional: which size was photographed (`photographed_size`, from the product's size chart labels).
2. **Upload.** Existing signed PUT. Server pipeline in section 3 (sniff, caps, ICC to sRGB, EXIF strip, AV scan). Original is stored private and is never overwritten.
3. **Background removal.** Existing `process` call, or the new batch endpoint for up to 50 photos with one preset. Result READY / NEEDS_REVIEW / FAILED with reasons. Seller can refine (brush add/erase, feather, smooth, edge shift; existing editor) or re-run with another allow-listed model.
4. **Studio.** For an accepted cutout version the seller chooses:
   - **Background**: `white` (default, `#FFFFFF`), `studio_grey` (`#F2F2F2`, recommended automatically for white garments), `brand` (one validated hex from store settings), or `transparent` (PNG only, never a listing primary image).
   - **Shadow**: `none | contact | soft` (soft is the existing sidecar shadow; contact is a short elliptical ground shadow for shoes and bags).
   - **Presentation template** (filtered by garment category, section 5): `none` (cutout centred on the background), a mannequin form, a hanger, a flat-lay board or a plinth.
   - **Placement**: automatic (section 5.3) with optional manual nudge (scale 0.9-1.1 of the automatic value, rotation within ±5°, translation within the template's safe box).
5. **Render.** Async job (section 7). The live preview on the device updates instantly; the server render arrives in seconds with gate results.
6. **Gate.** `PASSED`, `NEEDS_REVIEW` (soft checks failed, seller may accept with the reasons shown) or `BLOCKED` (a hard check failed: the seller cannot publish this render; the reasons and a fix are shown).
7. **Accept and attach.** The accepted render becomes the product image through the existing `images: [{ media_job_id }]` path, extended with `studio_render_id`. The original stays attached to the same `product_media` row.
8. **Variants.** On attach, AVIF and WebP variants (plus a JPEG fallback) are generated at fixed widths for DPR 1/2/3 (section 9), colour-checked again, and served through the existing media resolver.

Buyer flow: the product gallery shows the studio image; each edited image has an info button "About this photo" (AR first) that states the edit type and offers **"View original photo"** (signed link, rate-limited). On-model or detail photos without edits show no label.

## 3. Upload hardening (applies to every product photo, not only the studio)

| Step | Rule | Status today |
|---|---|---|
| Type | Magic-byte sniff; accept `image/jpeg`, `image/png`, `image/webp`; `image/heic`/`heif` is converted on the device by the picker before upload (verify on SDK 57, builder task S1-3). Declared type is ignored. | Built (jpeg/png/webp) |
| Size caps | Body at most 12 MiB; at most 4096 px per side and at most 24 Mpx decoded, checked from the header **before** full decode (decompression bomb); minimum 800 px on the long side for studio use (below it the studio is offered as background-only with reason `low_resolution`). | Byte and side caps built; Mpx cap and minimum are new |
| Colour profile | **Convert from the embedded ICC profile to sRGB before stripping metadata.** iPhone photos are usually tagged Display P3; dropping the profile without conversion shifts saturated reds and greens. Missing profile is treated as sRGB. Conversion with littleCMS through Pillow `ImageCms` (licences in section 12). | **Gap**: the sidecar README says ICC does not survive re-encode; no conversion is documented. Builder task S1-1, colour gate depends on it |
| Metadata | Strip EXIF (GPS, device, time), XMP, IPTC, maker notes and thumbnails by re-encoding from pixels. Keep orientation by applying it to pixels first. | Built (re-encode) |
| Malware | AV scan of the original object before any decode by the sidecar (`ScanState` `pending_scan -> clean | infected`); infected objects are quarantined, the job fails `infected`, a T&S event is raised. Engine and signature updates under egress-deny: VR-STUDIO-09. | Scan state exists in the port; engine choice open |
| Content | §27 image moderation (nudity, violence, AR/EN text toxicity) runs on the original; a flagged image cannot enter the studio. The studio never weakens moderation. | Depends on the T&S moderation spec; not composed |
| People | `on_model` photos are offered background replacement only, never templates. No face detection or recognition is run by the studio (segmentation masks do not identify anyone). P2 handling: VR-STUDIO-08 (narrows VR-P3-BG-06). | New rule |

## 4. Background removal (existing service, what the studio adds)

- **Model**: provisional default `u2netp`, candidate `birefnet-general-lite`; chosen from the benchmark on real photos (VR-P3-BG-05). Licences in section 12.
- **Quality score**: unchanged (`assessQuality`, READY at 70). The studio requires an **accepted** cutout version; a NEEDS_REVIEW cutout the seller accepted is allowed but its score is carried into the render gate (section 8, soft check `cutout_below_ready`).
- **Edge refinement and manual brush**: unchanged (existing refine, max 200 strokes, 2,000 points, 5 versions).
- **Batch**: new `studio_batches` (section 10): one preset (model, background, shadow, template per category), up to 50 uploads, each upload still its own cutout job and render (idempotent per upload). A batch never auto-accepts cutouts below READY; those wait for the seller.
- **Shot-type hints**: `hanger` keeps the hanger in the mask (it is part of the photo); `ghost_inner` is only used by the ghost-mannequin phase; `on_model` and `detail` skip templates.

## 5. Templates and size-aware placement

### 5.1 Template set (art is commissioned and owned; no stock assets without a licence, VR-STUDIO-04)

| Garment category | Templates (v1) | Anchor | Notes |
|---|---|---|---|
| `top` (t-shirt, shirt, blouse, knit) | torso form (neutral matte grey, faceless, no arms), wooden hanger, flat-lay board | neck centre (top-centre of the mask's main component) | Hanger template only for `flat_lay` shots; a `hanger` shot already has a hanger |
| `dress` | full torso-to-knee form, hanger, flat-lay | neck centre | Long dresses scale down to fit the safe box; never cropped at the hem |
| `trousers` / `skirt` | lower-body form (waist to ankle), clip hanger, flat-lay | waist centre (top-centre) | |
| `outerwear` | torso form with shoulder width +4 cm, hanger, flat-lay | neck centre | |
| `shoes` | plinth, floor line | bottom-centre | 1 or 2 components allowed (a pair) |
| `bags` | plinth, hook | bottom-centre (plinth) or handle top (hook) | |
| any | `none` (centred on background with padding 6%) | bbox centre | Always available, also the only option for `on_model`, `detail`, sets with several items |

Rules for the art: forms are visibly mannequins (matte, single neutral colour per set: white, grey, black), never realistic skin, faces or bodies, so no image can be mistaken for an on-model photo. Kids' categories have no template in v1 (owner decision O-6). Each template is a versioned bundle: back layer PNG, optional front layer PNG (hanger hook over the collar), `anchors.json` (anchor points, safe box, floor line), `px_per_cm`, reference measurements of the form in cm (for example torso form: height 175 cm body scale, chest 88 cm, waist 70 cm, shoulder 39 cm; **placeholders**, set by the art brief) and a SHA-256. Bundles are baked into the sidecar image (like the models) and listed in a `templates.lock.json`; nothing is fetched at runtime. SVG is not accepted (script and entity risk).

### 5.2 Hard rule: rigid transforms only

The garment layer may be transformed only by: uniform scale (same factor on both axes), rotation within ±5° (auto-straighten from the principal axis of the mask), and translation. **Forbidden**: non-uniform scale, perspective, mesh warp, liquify, inpainting, hem or sleeve extension, colour grading, sharpening beyond the variant encoder, adding or removing any garment detail. This is enforced twice: the compose request schema has no field that could express anything else, and the structure gate (section 8) compares the rendered garment with the source.

### 5.3 Placement algorithm

Inputs: accepted cutout RGBA (sRGB), garment category, template bundle, optional `photographed_size` and the product's size chart row for that size (garment measurements in cm, already validated monotonic by the size-chart rules of §10).

1. Main component: largest alpha component (shoes: up to 2, both kept). Bounding box `(w_px, h_px)` on alpha > 0.5.
2. Garment length in px: `h_px` for top, dress, trousers, skirt, outerwear, shoes (pairs: per-shoe length = max component extent along its principal axis); `w_px` for bags.
3. **Chart-scaled** (when `photographed_size` and the chart row give length `L_cm`): `s = (L_cm * template.px_per_cm) / length_px`. Cross-check: `r_chart = width_cm / L_cm` (chest flat width for tops, waist flat for trousers, etc.), `r_mask = width_at_measure_line_px / length_px`, measure line defined per category in the template (tops: 30% of length below the anchor). If `|r_mask - r_chart| / r_chart > tol` (`tol = 0.12`, placeholder, VR-STUDIO-06) the photo is foreshortened or the chart is wrong: placement becomes `NEEDS_REVIEW` with reason `chart_mismatch`, and the render falls back to unscaled.
4. **Unscaled** (no chart, no size, or mismatch): `s` fits the length into the template's safe box (no size claim). The caption never mentions size.
5. Rotation: `θ = clamp(-principal_axis_tilt, -5°, +5°)`; a larger tilt yields `NEEDS_REVIEW` reason `tilted_photo` and no rotation beyond 5°.
6. Translate the anchor of the mask to the template anchor; if any garment pixel leaves the safe box, reduce `s` (never crop) and mark `scaled_to_fit` (chart scaling then no longer holds: caption without size).
7. Layering: template back layer, contact or soft shadow (never over garment pixels), garment, template front layer (only hooks and clips, and never over more than 2% of garment pixels; otherwise the front layer is dropped).
8. Resampling: Lanczos-3 on premultiplied alpha; output at most 2048 px long side; never upscale the garment above 1.0 of its source resolution (if the template needs upscaling, the canvas shrinks instead).

Caption (shown under "About this photo", only for chart-scaled renders): "Shown on a display form (chest 88 cm). Item shown: size M." Values come from the template and the chart; nothing is estimated.

Ghost mannequin (phase S3, section 15): two real shots (`ghost_front` on a physical mannequin, `ghost_inner` showing the inside back neck) are cut out, the mannequin is removed from the front mask using the seller-marked or detected neck region, and the inner neck patch is placed with a rigid transform behind the neckline. Every pixel is still photographed; the structure gate applies to both inputs.

Generative on-model: section 14. Not built.

## 6. Studio backgrounds

| Background | Value | Allowed for listing primary image | Notes |
|---|---|---|---|
| `white` | `#FFFFFF` | yes (default) | Contrast check (section 8) recommends `studio_grey` for light garments |
| `studio_grey` | `#F2F2F2` | yes | |
| `brand` | one hex from store settings, validated `^#[0-9A-F]{6}$`, contrast ratio against the garment boundary checked | yes, if `media.brand_backgrounds` entitlement is true | No gradients, images or text; no logos composited into product images (a logo on a product photo could read as the product's branding) |
| `transparent` | PNG with alpha | no (secondary image or Stylist/outfit composition only, which already uses `cutout_url`) | |

Shadows are synthetic and labelled as part of the edit type `composited`; they never touch garment pixels.

## 7. Async job pipeline

### 7.1 Render state machine (explicit table, A2.6)

`QUEUED -> RENDERING -> (PASSED | NEEDS_REVIEW | BLOCKED | FAILED)`; `PASSED | NEEDS_REVIEW -> ACCEPTED | REJECTED`; `FAILED -> QUEUED` (automatic retry while `attempts < 3`, then seller re-run); `BLOCKED` and `REJECTED` are terminal for that render (the seller creates a new render with other parameters); `ACCEPTED -> SUPERSEDED` when another render of the same job is accepted; any non-terminal state `-> CANCELLED` when the job, product or store is deleted. A `RENDERING` row older than 2 minutes is failed `stale_rendering` by the sweeper. Invalid transitions throw a typed error; every transition unit-tested plus a property test that no sequence reaches an unreachable state.

### 7.2 Mechanics

- **Enqueue**: `POST .../studio-renders` writes the row `QUEUED` and an outbox event in one transaction. Idempotency: `Idempotency-Key` header (A2.5) **and** a natural key `UNIQUE (store_id, job_id, source_version, params_hash)`; the same parameters on the same cutout version return the existing render (200), so double taps and batch replays never render twice or charge quota twice.
- **Worker**: claims with `SELECT ... FOR UPDATE SKIP LOCKED LIMIT 4` ordered by `created_at`, per-store fairness (at most 2 in flight per store), sets `RENDERING`, calls the sidecar `/v1/compose` (timeout 15 s), runs the gate, stores the render privately, writes the result and outbox event in one transaction.
- **Retries**: transient errors (sidecar 429/503/504, storage 5xx) retry with exponential backoff and full jitter (base 2 s, cap 60 s, max 3 attempts). Permanent errors (422 bad input, gate BLOCKED) do not retry.
- **DLQ**: after the last attempt the row is `FAILED` with `dead_lettered = true`; the Admin console lists dead letters with a replay action (audited, ops role). Alert when dead letters exceed 1% of renders in 1 hour.
- **Cost caps**: before enqueue, check (a) kill switch, (b) entitlement `media.studio_renders_per_month` against `entitlement_usage` (key `media.studio_renders`, increment in the enqueue transaction, refunded on FAILED-by-platform), (c) the existing per-store abuse ceiling of 200 runs/UTC day shared with cutouts, (d) a global circuit breaker on queue depth (above 5,000 queued the endpoint returns 503 `studio_busy` with `Retry-After`).
- **Kill switches** (ADR-0028 allowed-when-true, default blocked): `kill.photo_studio` (templates and backgrounds), `kill.photo_studio_ghost` (phase S3), `kill.photo_studio_generative` (never enabled; no adapter exists). A blocked switch stops new renders only; published images, originals and reads keep working.
- **Production composition**: Unconfigured compose adapter fails closed with 503 `provider_not_configured` (ADR-0029), same as the cutout provider.

### 7.3 On-device vs server

| Option | Complexity | Accuracy and reproducibility | Cost | Privacy and residency | Verdict |
|---|---|---|---|---|---|
| On-device render (Skia or native image APIs) | Medium (two platforms, device-specific colour management) | Varies by OS and GPU; no stored evidence of the gate | Free | Best (no extra upload) | Preview only |
| On-device segmentation (iOS Vision subject lifting) | Low on iOS, none on Android yet | Unbenchmarked on garments; OS-version-dependent (availability vs app minimum iOS is VR-STUDIO-07) | Free | Best | Not in v1; may become an offline preview |
| Server render in the sidecar | Low (pure numpy/Pillow next to the cutout code) | Deterministic, gated, versioned | CPU milliseconds (section 13) | Same in-region, egress-deny pod as cutouts | **Authoritative** |

### 7.4 Residency

The compose endpoint runs inside the existing bg-removal pod: in the ADR-0002 region, egress denied, no state, no logs of image content. Seller product photos are P1 by default; a photo with a person is P2 (no P3 is ever extracted: no face, body or measurement processing). No image leaves the region; any external image API (remove.bg, PhotoRoom, generative vendors) is an optional port implementation with `residency: "external"`, left Unconfigured, and refused without a transfer licence and the `cross_border_ml` consent (B1, ADR-0002, ADR-0051).

## 8. Quality gate before publish

All checks run on the server render and again on each lossy variant. Pixels compared are the **garment interior**: source cutout alpha = 255, eroded by 3 px, deterministic grid sample of at most 50,000 pixels, mapped to the render by the stored transform.

| Check | Measure | Threshold (placeholder until VR-STUDIO-05/06) | Kind |
|---|---|---|---|
| `colour_delta_e` render vs source cutout | CIEDE2000 in CIELAB (D65) from sRGB | median ≤ 1.0 and p95 ≤ 3.0 | **Hard** |
| `colour_delta_e` lossy variant vs render | CIEDE2000 | median ≤ 2.0 and p95 ≤ 6.0 per variant; a failing variant is re-encoded at higher quality once, then dropped (JPEG fallback kept) | Hard per variant |
| `colour_delta_e` source cutout vs original upload (after ICC to sRGB) | CIEDE2000 on the interior | median ≤ 1.0 | **Hard** (catches a cutout or decontamination step that recolours the garment) |
| `structure_ssim` | SSIM on luminance, render garment resampled back to source scale | ≥ 0.97 | **Hard** (catches any invented or removed detail) |
| `geometry` | Transform in the record is rigid: uniform scale, \|θ\| ≤ 5° | exact | **Hard** |
| `no_crop` | Every source garment pixel present in the render | 100% | **Hard** |
| `resolution` | Garment long side in the render | ≥ 800 px | **Hard** (else background-only offer) |
| `edit_label` | Label computed and stored | present | **Hard** |
| `cutout_below_ready` | Cutout version score | < 70 | Soft |
| `chart_mismatch`, `tilted_photo`, `scaled_to_fit` | Section 5.3 | as defined | Soft |
| `low_contrast_background` | CIEDE2000 between mean garment boundary colour and background | < 3.0, suggest `studio_grey` or another brand colour | Soft |
| `multiple_components` | Components > 1 (shoes > 2) | templates refused; `none` allowed | Soft |

Note: the colour checks prove the pipeline did not change colour. They cannot prove the seller's photo matches the physical garment (lighting, white balance). A later phase may add an optional grey-card reference shot; until then the original is the evidence and "not as described" returns are a guardrail metric.

## 9. Storage, variants and CDN

- Private object keys, content-addressed: `product-media/{store}/{job}/renders/{renderId}.png` (master, sRGB PNG, at most 2048 px); variants `catalog/yyyy/mm/{uuid}/{w}.{avif|webp|jpg}` created on attach.
- Widths: 320, 480, 640, 960, 1280, 1600, 2048 (cover DPR 1/2/3 for the mobile card, PDP and zoom); never above the master. AVIF (quality tuned so the colour gate passes, 4:4:4 chroma if 4:2:0 fails it), WebP, JPEG fallback. Encoders: libavif/libaom or the platform image service (licence check in section 12).
- Every variant embeds an sRGB ICC tag (small) so browsers do not guess.
- Serving: through the existing media resolver as short-lived signed links (current behaviour for product images); a public CDN cache for active product images is an infra decision outside this spec (open item O-8). Image payload budget per PDP above the fold ≤ 400 KB (§25) is checked in CI.
- Original: kept private for as long as the product image is live, and as long as any order line snapshot references it (consumer evidence); served to buyers only through `GET .../original` (section 11).
- Retention: rejected, blocked or superseded renders deleted after 30 days; failed after 7 days; through the existing `product_media_blob_graveyard`. `data_inventory.yaml` rows for every new table and column (builder task, CI fails otherwise).

## 10. Data model (additive migrations; Kysely; RLS on `app_store_ids()`)

| Table | Key columns | PII |
|---|---|---|
| `product_media_jobs` (existing, add columns) | `shot_type text CHECK (flat_lay, hanger, mannequin, ghost_front, ghost_inner, on_model, detail)`, `garment_category text NULL`, `photographed_size text NULL`, `icc_source text NULL` (for example `display_p3`, `srgb`, `none`) | P1 (P2 when `on_model`) |
| `studio_templates` | `id, code, category, kind mannequin|hanger|flat_lay|plinth|none, version int, bundle_sha256, px_per_cm numeric, reference_measurements jsonb, anchors jsonb, safe_box jsonb, status draft|active|retired, approved_by, created_at`; `UNIQUE (code, version)`; seeded from `templates.lock.json` by migration, not edited at runtime | P0 |
| `studio_renders` | `id, store_id, job_id, source_version int, template_id NULL, template_version int NULL, params jsonb (background, hex, shadow, placement mode, nudge), params_hash bytea, transform jsonb (scale, rotate_deg, dx, dy), status, gate jsonb (per check: value, threshold, pass), gate_result passed|needs_review|blocked, edit_label, caption_ar, caption_en, render_ref, variants jsonb, attempts smallint, dead_lettered bool, error_code, decision none|accepted|rejected, decided_by, idempotency_key, version int, created_at, updated_at`; `UNIQUE (store_id, job_id, source_version, params_hash)`; index `(status, created_at)` for the claim, `(store_id, job_id)` | P1 (P2 when the job is `on_model`) |
| `studio_batches` | `id, store_id, preset jsonb, total, queued, done, failed, status open|running|done|cancelled, created_by, idempotency_key UNIQUE, created_at` | P1 |
| `studio_batch_items` | `batch_id, upload_id, job_id, render_id NULL, status` | P1 |
| `product_media` (existing, add columns) | `studio_render_id NULL`, `edit_label text NOT NULL DEFAULT 'none'`, `original_ref` (already the scanned original for `use_original`; becomes NOT NULL for every job-backed image) | P1 |
| `entitlement_usage` (ADR-0056) | key `media.studio_renders`, period month | P1 |
| outbox | events in section 11.2 | P1 |

`edit_label` values: `none` (original), `background_replaced` (cutout on a plain background, no template), `composited` (template, shadow or brand background), `ai_generated` (reserved; no producer exists). Labels are derived by code from the parameters, never typed by the seller.

New ADR-0056 entitlement definitions (values per plan are owner data, O-3):

| Key | Kind | Enforcement point | Downgrade policy |
|---|---|---|---|
| `media.studio_renders_per_month` | int | `POST .../studio-renders`, batch enqueue | block_new (published images stay) |
| `media.batch_max_items` | int (≤ 50) | batch create | immediate |
| `media.templates` | enum set `none, flat_lay, hanger, mannequin, plinth` | render create | block_new |
| `media.brand_backgrounds` | bool | render create | block_new |
| `media.ghost_mannequin` | bool | phase S3 | block_new |

No entitlement can switch off the original view, the label, or any gate (ADR-0056 hard rule).

## 11. API sketch (OpenAPI to be added by the builder; Problem+JSON errors; cursor pagination)

### 11.1 Endpoints

| Method and path | Auth scope | Idempotent | Rate limit | Notes |
|---|---|---|---|---|
| `POST /v1/seller/stores/{storeId}/product-media/uploads` (existing) | `store_product` create (owner, manager, catalog) | yes (existing) | existing | Adds optional `shot_type`, `garment_category`, `photographed_size` |
| `PATCH /v1/seller/stores/{storeId}/product-media/{jobId}` | `store_product` update | `If-Match` version | 60/min/store | Sets `shot_type`, `garment_category`, `photographed_size` |
| `POST /v1/seller/stores/{storeId}/product-media/batches` | `store_product` create | `Idempotency-Key` | 10/min/store | Body `{ upload_ids: uuid[1..50], preset }`; 202 with batch id |
| `GET /v1/seller/stores/{storeId}/product-media/batches/{batchId}` | `store_product` read | n/a | 120/min | Progress and items |
| `GET /v1/seller/stores/{storeId}/photo-studio/templates?category=` | `store_product` read | n/a, ETag | 60/min | Only templates allowed by entitlement are marked `available` |
| `POST /v1/seller/stores/{storeId}/product-media/{jobId}/studio-renders` | `store_product` create | `Idempotency-Key` + natural key | 30/min/store | Body `{ source_version, template: { id, version } | null, background: { kind, hex? }, shadow, placement: { mode: "auto" } | { mode: "nudge", scale_factor 0.9..1.1, rotate_deg -5..5, dx, dy within safe box } }`; 202 `{ render_id, status }`, 200 if it already exists |
| `GET /v1/seller/stores/{storeId}/product-media/{jobId}/studio-renders/{renderId}` | `store_product` read | n/a | 120/min | Status, gate, signed preview link ≤ 10 min |
| `POST /v1/seller/stores/{storeId}/product-media/{jobId}/studio-renders/{renderId}/decision` | `store_product` update | `Idempotency-Key` | 30/min | `{ decision: accepted | rejected }`; `accepted` refused 409 `render_blocked` when `gate_result = blocked` |
| `POST /v1/seller/products`, `PATCH /v1/seller/products/{id}` (existing) | existing | existing | existing | `images[]` entries may carry `{ media_job_id, studio_render_id? }`; the render must be ACCEPTED and belong to the job |
| `GET /v1/products/{id}` (existing) | public | ETag | existing | Each image gains `edit_label`, `caption` (AR/EN, nullable) and `has_original: boolean`; no job or render ids |
| `GET /v1/products/{id}/images/{imageId}/original` | public (guest allowed, ADR-0055) | n/a | 20/min/IP, 60/min/user | 302 to a signed link ≤ 10 min, only while the product is active; 404 otherwise |
| `GET/POST /v1/admin/photo-studio/dead-letters`, `.../{renderId}/replay` | admin `ops` | `Idempotency-Key` on replay | 30/min | Audited |
| `GET /v1/admin/photo-studio/templates` | admin `ops`, `catalog_quality` | n/a | | Templates are seeded by migration; activation/retirement is an audited admin action |

Authorization: a foreign store, job or render returns 404 (BOLA); shopper calling seller routes 403; every endpoint gets a negative authorization test (seller A to seller B render = 404; catalog role to admin replay = 403; support role cannot create renders).

Errors: 422 `invalid_transform`, `template_category_mismatch`, `cutout_not_accepted`, `source_version_missing`, `low_resolution`; 409 `render_blocked`, `version_conflict`; 429 `quota_exceeded` (with the entitlement key), `rate_limited`; 503 `photo_studio_disabled`, `provider_not_configured`, `studio_busy`.

Sidecar (internal, allow-listed host, no redirects, no credentials): `POST /v1/compose` multipart `{ cutout_png, template_code, template_version, params json }` -> `{ render_png_b64, transform, gate_inputs (sampled pixel arrays are not returned; the sidecar returns computed ΔE and SSIM statistics), latency_ms, renderer_version }`. The API re-validates the response schema, magic bytes and size.

### 11.2 Events (Zod-typed)

Outbox (domain): `product_media.studio_render.queued`, `.completed { gate_result }`, `.failed { code, dead_lettered }`, `.decided { decision }`, `product_media.batch.completed { done, failed }`, `product_media.image_published { edit_label }`.

Analytics (consent-aware, no PII, no image content): seller `studio_opened`, `studio_template_selected { category, kind }`, `studio_render_accepted { gate_result, edit_label }`, `studio_render_rejected { reasons[] }`; shopper `photo_info_opened { edit_label }`, `original_photo_viewed { edit_label }`.

## 12. Licences (research summary, not legal advice; every "open" or "reported" item is a VERIFY row)

| Component | Use | Licence as recorded or reported | Status |
|---|---|---|---|
| `u2netp`, `u2net` (U-2-Net) | cutout | Apache-2.0 code and weights (repo `MODEL_LICENSES.md`) | Usable pending VR-P3-BG-01/03 |
| `birefnet-general-lite` (BiRefNet) | cutout | MIT code and weights (repo `MODEL_LICENSES.md`) | Usable pending VR-P3-BG-01/03 |
| `isnet-general-use` (IS-Net) | cutout | Code Apache-2.0; weights licence not explicit | **Not cleared** (VR-P3-BG-02) |
| BRIA RMBG-1.4, RMBG-2.0 | none | **Non-commercial** | **Excluded**; the sidecar refuses the names (tested) |
| rembg, onnxruntime | runtime | MIT, MIT | Usable |
| Pillow, numpy, littleCMS (via Pillow ImageCms) | compose, ICC | Reported HPND (Pillow), BSD-3 (numpy), MIT (littleCMS) | Confirm at pin time (VR-STUDIO-09 covers the SBOM review) |
| CIEDE2000 and SSIM | gate | Implemented in-house in numpy (formulae are public); avoids a dependency | n/a |
| libavif / libaom, libwebp | variants | Reported BSD-2 / BSD-3 style | Confirm at pin time |
| ClamAV (if chosen) | AV scan | Reported GPL-2.0, run as a separate process | VR-STUDIO-09 |
| Mannequin, hanger, board, plinth art | templates | Commissioned, copyright assigned to Z-OUTLET | VR-STUDIO-04 |
| Generative try-on (IDM-VTON, OOTDiffusion and similar) | not used | **Reported non-commercial (CC BY-NC-SA style); not verified in this session** | Not built; VR-STUDIO-03 |
| Diffusion base models (SDXL, FLUX.1 variants) | not used | Reported mixed: some permissive with use restrictions, some non-commercial; not verified | Not built; VR-STUDIO-03, VR-AI-01, VR-AI-04 |

## 13. Cost and carbon per image (estimates; to be measured, VR-STUDIO-10)

SCI per image `= (E x I) + M`. Grid intensity `I` for the ADR-0002 region is unknown (VR-18); the formula is filled in once the region is chosen.

| Step | Compute (estimate, CPU unless noted) | Energy order of magnitude | Notes |
|---|---|---|---|
| Upload checks, ICC, EXIF strip | ~50-150 ms, 1 vCPU | ~0.0001 Wh | |
| Cutout `u2netp` | ~0.5-2 s, 1 vCPU (unbenchmarked) | ~0.001-0.003 Wh | `birefnet-general-lite` expected several times slower on CPU |
| Compose and gate | ~100-400 ms, 1 vCPU | ~0.0003 Wh | Lanczos resample, ΔE on 50k samples, SSIM |
| Variants (7 widths x 3 formats) | ~1-3 s, 1 vCPU | ~0.002 Wh | AVIF dominates; fewer widths if budget requires |
| Generative on-model (not built, for comparison) | ~10-30 s on one data-centre GPU | ~1-3 Wh | Two to three orders of magnitude more energy per image, plus fixed GPU cost |

FinOps: cost per accepted studio image and per 1,000 renders on the Admin FinOps dashboard; budget alert when monthly studio CPU cost exceeds the owner-set budget (O-3).

## 14. Generative on-model step (assessed, not built)

Considered because the owner said "maybe puts it on a mannequin": a generative model can "dress" a person or mannequin. It is not built because:

1. **Honesty.** Try-on diffusion re-synthesises the garment: it can change colour, print, length, drape and fit, and it invents fabric behaviour it never saw. A2.13 and CPL 181/2018 (not-misleading presentation; article text VR-07/VR-REV-01) make that the highest-risk image type in the catalog. Our structure gate (SSIM ≥ 0.97 against the photographed garment) would fail by design.
2. **Licences.** The try-on models we know of are reported non-commercial; not verified (VR-STUDIO-03).
3. **Residency and vendor.** ADR-0051 rules out an external AI vendor; self-hosting needs GPUs in the ADR-0002 region (VR-AI-02).
4. **Cost and carbon.** Section 13.

If the owner later wants it, the minimum conditions are: licence cleared; self-hosted in region; never the primary image; label `ai_generated` with AR/EN text "AI-generated illustration; see the real photos" on the image itself and in "About this photo" (wording VR-STUDIO-01); original always next to it; structure and colour gates on the garment region with thresholds the owner and counsel accept; Apple and consumer rules re-checked (VR-STUDIO-07); chief-reviewer sign-off. `kill.photo_studio_generative` stays blocked until then.

## 15. Edge cases

- White garment on white backdrop: existing `white_on_white_risk`; studio recommends `studio_grey` (soft check `low_contrast_background`).
- Lace, mesh, sheer fabric: mask holes are real; `mask_holes` is soft; the seller can accept. Background shows through holes; a mannequin form behind sheer fabric is shown honestly as a form.
- Sets and multiple items in one photo: templates refused (`multiple_components`), background-only allowed.
- Shoes: a pair (2 components) is allowed; one shoe is allowed.
- Garment longer than the template (maxi dress on a knee-length form): scaled to fit (`scaled_to_fit`), never cropped, no size caption; owner may commission a long form (O-6).
- Size chart edited after a chart-scaled render: the render is marked `stale_reason = size_chart_changed`; the caption is hidden at once; the seller is asked to re-render (no automatic charge).
- Template retired: existing renders keep the pinned version; new renders use the active version.
- Seller deletes the original upload: not allowed while an image or order snapshot references it (409 `original_in_use`).
- Product deleted or store suspended: renders cancelled, blobs buried through the graveyard; order-snapshot images are kept under the order retention rule.
- Kill switch flips during a render: running renders finish; new ones get 503; published images unaffected.
- Concurrent accept of two renders of the same job: compare-and-set on the job version; the second gets 409 and the first stays accepted.
- Offline (mobile): preview works on-device; the render request is queued locally with its idempotency key and sent on reconnect.
- RTL and Arabic: captions and labels AR first, numerals per user preference; templates are not mirrored (mirroring a garment would misrepresent asymmetric prints), only the UI is.
- Zero or extreme values: `scale_factor` outside 0.9-1.1, rotation outside ±5° or translation outside the safe box: 422; a source image with alpha all zero: 422 `no_subject`.

## 16. Threat model (STRIDE, short)

| Threat | Vector | Control |
|---|---|---|
| Malicious image (Tampering, DoS, EoP) | Decompression bomb, polyglot file, malformed ICC or EXIF exploiting a decoder, oversized PNG chunks | Magic-byte sniff; header pixel cap before decode; AV scan before decode; sidecar re-checks caps; decoders pinned and patched (Renovate, SBOM); sidecar runs non-root, read-only root, tmpfs, CPU and memory limits, egress denied; ICC parsed only by littleCMS inside the sidecar |
| SSRF | Template or background fetched by URL; webhook-like callbacks | No URL inputs at all: templates are baked bundles referenced by code and version; brand colour is a hex string; API to sidecar over an allow-listed host with no redirects and no credentials |
| Prompt injection | n/a: no LLM, no text prompt in this pipeline | If a generative step is ever added, OWASP LLM01/LLM05 mapping is required first |
| Cross-tenant access (Information disclosure) | Seller A reads or accepts B's render; guessing render ids | Policy guard + RLS; 404 for foreign objects; ids are UUIDv7 but never trusted for authorization |
| Misleading content (Repudiation, legal) | Seller uses templates to hide defects or misstate length | Rigid-only transforms, hard colour/structure/no-crop gates, original always available to buyers, `edit_label` derived by code, defect photos (§4 condition) cannot be studio-processed into the primary slot (a `detail` shot is background-only), "Report photo" on the PDP feeds T&S |
| Template asset tampering (Supply chain) | Modified template PNG in the image | `templates.lock.json` SHA-256 verified at build and at start; image signed (cosign) like the rest |
| Cost abuse (DoS of wallet) | Bulk renders to burn CPU | Entitlement cap, per-store 200/day ceiling, rate limits, global queue circuit breaker, natural-key dedup |
| Original link scraping | Enumerating `/original` | Signed links ≤ 10 min, rate limits, only active products, no listing endpoint |
| Personal data in photos | Bystander or model in the photo | No face or body processing; `on_model` gets background-only; P2 classification and retention; VR-STUDIO-08 |

Mapping: OWASP API1 (BOLA), API4 (resource consumption), API6 (business-flow abuse: batch), API7 (SSRF), API8 (misconfiguration: kill switches fail closed), API10 (sidecar response validated). ASVS V12 file handling. LLM Top 10 not applicable while no model generates content.

## 17. Metrics

- Product: share of active listings with a studio primary image; render acceptance rate; time from upload to published image p50/p95; batch completion rate.
- Honesty guardrails: "not as described" return rate and "photo misleading" reports for studio images vs original-only images (A/B by store cohort); original-view rate; any render published with a failed hard gate (target 0, alert on 1).
- SLI/SLO: compose p95 ≤ 3 s per render (excluding the cutout); batch of 50 ≤ 5 min p95 when the queue is below 500; dead-letter rate < 0.5% per day; colour-gate false-block rate measured on the benchmark set.
- Cost and carbon: CPU-seconds and cost per accepted image; gCO2e per image once VR-18 closes.

## 18. Acceptance (Gherkin; become tests)

1. *Given* a seller uploads a flat-lay t-shirt photo tagged Display P3, *when* the upload is processed, *then* the stored original is converted to sRGB, has no EXIF/GPS, and the interior colour of the cutout is within median CIEDE2000 1.0 of the converted original.
2. *Given* an accepted cutout of a size-M t-shirt with a size chart row (length 70 cm, chest flat 52 cm) and the torso template, *when* the seller renders with automatic placement, *then* the garment scale equals `70 x px_per_cm / length_px` within 1%, rotation is within ±5°, the gate passes, and the caption reads "Item shown: size M".
3. *Given* the mask width-to-length ratio differs from the chart ratio by more than 12%, *when* rendered, *then* the render is NEEDS_REVIEW with `chart_mismatch`, it is unscaled and has no size caption.
4. *Given* any render, *when* its stored transform has non-uniform scale or rotation above 5°, *then* the gate is BLOCKED and the decision endpoint returns 409 `render_blocked` (property test over random transforms).
5. *Given* a render whose garment interior median CIEDE2000 against the source exceeds the threshold, *then* it is BLOCKED and cannot be attached to a product.
6. *Given* the same `Idempotency-Key` or the same (job, source version, parameters), *when* the request is repeated 5 times concurrently, *then* exactly one render row exists and quota is counted once.
7. *Given* the sidecar returns 503 three times, *then* the render is FAILED with `dead_lettered = true`, an admin replay re-queues it once, and quota is refunded.
8. *Given* `kill.photo_studio` is blocked, *when* a seller requests a render, *then* 503 `photo_studio_disabled`, and published studio images and `GET .../original` still work.
9. *Given* a buyer (or a guest) on a product with a composited image, *when* they open "About this photo", *then* they see the edit type in Arabic first and can open the original within one tap, served as a signed link of at most 10 minutes.
10. *Given* seller A and a render id of seller B, *when* A calls GET or decision, *then* 404; a support-role seller user calling create gets 403.
11. *Given* an `on_model` photo, *when* the seller opens the studio, *then* only backgrounds are offered and template requests return 422 `template_category_mismatch`.
12. *Given* a plan whose `media.studio_renders_per_month` is exhausted, *then* 429 `quota_exceeded` names the entitlement key; when the entitlement read fails, the fallback plan values apply (fail closed).
13. *Given* a batch of 50 uploads with one preset, *then* every cutout below READY waits for the seller, no cutout is auto-accepted, and the batch reports done and failed counts that sum to 50.
14. *Given* a published image whose size chart is later edited, *then* the size caption disappears immediately and the render is marked stale.

## 19. Tasks, tiers and dependencies

| # | Task | Tier | Depends on |
|---|---|---|---|
| S0 | This spec and ADR-0059 | Architect (done) | — |
| S1-1 | ICC to sRGB conversion before strip in the sidecar, `icc_source` column, tests with P3 fixtures | Builder; Tester | — |
| S1-2 | Header pixel cap (24 Mpx) before decode; 800 px studio minimum | Builder | — |
| S1-3 | Confirm HEIC conversion in the picker on SDK 57 (device test) | Builder (mobile) | — |
| S1-4 | AV engine choice and composition under egress-deny | Architect (design), Builder, then chief-reviewer only if it touches the security sign-off at launch | VR-STUDIO-09 |
| S2-1 | Pure domain: render state machine, placement maths, transform validation, edit-label derivation, gate evaluation (property tests: rigid only, no crop, labels) | Builder; Tester (property + mutation ≥ 80% on gate and placement) | S0 |
| S2-2 | Sidecar `/v1/compose`: layering, Lanczos resample, CIEDE2000 and SSIM in numpy, template bundles and `templates.lock.json` | Builder (Python, mypy strict, ruff); Tester | S2-1 contract, template art (O-1) |
| S2-3 | Migrations, Kysely store, RLS, `data_inventory.yaml` rows | Builder | S2-1 |
| S2-4 | Postgres queue worker, retries, DLQ, sweeper, admin replay | Builder; Tester (chaos: kill worker mid-render, no double render) | S2-3 |
| S2-5 | API routes, Zod DTOs, OpenAPI, negative authorization tests | Builder; Tester | S2-3 |
| S2-6 | Entitlement keys and enforcement | Builder | ADR-0056 module exists (not built) — until then a config default per store |
| S2-7 | Variants (AVIF/WebP/JPEG) with per-variant colour gate | Builder | S2-2 |
| S2-8 | Shopper: `edit_label`, caption, "About this photo", original link (mobile and later web) | Builder (UI per `docs/design-system/ux-principles.md`) | S2-5; O-2 wording; VR-STUDIO-01 |
| S2-9 | Seller UI: studio step in mobile brand mode and Seller Center media page, live preview | Builder | S2-5 |
| S2-10 | Benchmark extension: real photos for ΔE, SSIM and placement thresholds | Tester / ML (owner supplies photos) | VR-P3-BG-05, VR-STUDIO-05/06 |
| S3-1 | Ghost mannequin from two shots | Architect (algorithm), then Builder | S2 complete; O-5 |
| S4 | Generative on-model | Not planned; Architect + chief-reviewer if ever reopened | VR-STUDIO-03, VR-STUDIO-01, VR-STUDIO-07, VR-AI-01/02 |

No task needs the Quick-fix tier. Chief-reviewer is not required for S1-S3 (no money, auth model or residency change; the sidecar stays in the already-reviewed pod); it is required before S4 and before enabling `kill.photo_studio` in production if VR-STUDIO-08 changes the P2 handling.

## 20. Owner decisions (separate from VERIFY rows)

| # | Decision | Default until decided |
|---|---|---|
| O-1 | Commission the template art (style: white, grey or black matte forms; which categories first; budget) | No templates; studio offers backgrounds and `none` only |
| O-2 | Buyer-facing label wording and placement for `background_replaced` and `composited` (AR/EN) | Info button "About this photo" with neutral text; no badge on the image itself |
| O-3 | Entitlement values per seller plan; monthly studio CPU budget | Fallback plan: 100 renders/month, batch 20, templates `none, flat_lay, hanger`, brand backgrounds off (placeholders) |
| O-4 | Whether generative on-model is ever wanted | No; kill switch blocked; not built |
| O-5 | Ghost mannequin phase (needs sellers with a physical mannequin) | Not scheduled |
| O-6 | Kids' and long-length templates | None in v1 |
| O-7 | Whether a studio image may be the primary image by default or the seller must choose | Seller chooses; original stays primary until a render is accepted |
| O-8 | Public CDN caching of active product images vs signed links | Signed links (current behaviour) |

## 21. VERIFY BEFORE LAUNCH (rows in `docs/compliance/verify-register.md`)

VR-STUDIO-01 labelling duty and wording · 02 Seller Agreement image licence and warranty · 03 generative model licences · 04 template art IP · 05 colour thresholds and ICC on real photos · 06 placement tolerance on real photos · 07 Apple rules and on-device API availability · 08 people in seller photos · 09 AV engine and dependency licences under egress-deny · 10 measured cost and carbon per image · 11 tax treatment if the studio is sold as a paid add-on.
