# Product photo background removal (seller catalog media)

Master prompt refs: §19 (catalog: bulk images with automatic background cleanup), §T5 (upload pipeline),
§B1 (residency). Kill switch `kill.background_removal` (allowed-when-true, default blocked, ADR-0028).

## Flow
1. `POST /v1/seller/stores/:storeId/product-media/uploads` -> signed PUT for the private original, job PENDING.
2. Browser PUTs the file; the object store strips EXIF/GPS and scans it (existing pipeline).
3. `POST .../:jobId/process` -> validate (jpeg/png/webp, 12 MB, 4096 px, sniffed not declared), cut out in the
   sidecar, edge cleanup and crop, quality score, private derivatives (transparent PNG, white JPG 1600 px,
   optional shadow PNG). Status READY (score >= 70) or NEEDS_REVIEW, or FAILED with a code.
4. Seller: `accept`, `use-original`, or `rerun` with another model from the allow-list.

## Rules
- State machine PENDING -> PROCESSING -> READY | NEEDS_REVIEW | FAILED; re-run returns to PENDING. A PROCESSING
  row older than 5 minutes is failed (`stale_processing`) and can be re-run. Max 5 runs per photo.
- Idempotent per upload id (unique store + original key); writes carry `Idempotency-Key`.
- Per-store quota 200 runs per UTC day (429 `quota_exceeded`).
- Originals and derivatives are never public; links are signed, at most 15 minutes (default 10).
- Provider default is Unconfigured: 503 `provider_not_configured`. Blocked switch: 503
  `background_removal_disabled`; decisions and reads keep working so sellers are never stuck.
- An external provider (`residency: external`) is refused without the `cross_border_ml` consent.

## Authorization
`store_product` read (owner, manager, catalog, warehouse, support, finance) for GET; create/update (owner,
manager, catalog) for writes; a foreign store or job is 404, RLS on `app_store_ids()` underneath.

## Data
`product_media_jobs`, `product_media_usage`, `product_media_blob_graveyard` (migration 0083). Retention: the
retention worker deletes unprocessed/failed jobs after 7 days and undecided cutouts after 30; a trigger
buries every blob key and the worker erases the objects.

## Threats
Decompression bombs (pixel cap before decode, sidecar re-checks), SSRF to the sidecar (allow-listed host,
no redirects, no credentials), response tampering (strict schema, magic bytes, size cap), prompt-less so no
injection surface, cost abuse (quota + rate limits), cross-tenant access (policy + RLS), model licence risk
(VR-P3-BG-01..03).

## Linking a decided photo to the product (migration 0085)

- Request (additive, `POST /v1/seller/products`, `PATCH /v1/seller/products/{id}`): `images: [{ upload_id } | { media_job_id }]`, ordered, at most 12, exclusive with `image_upload_ids`.
- A `media_job_id` must be a job of the same store whose decision is `accepted` or `use_original`. Unknown or other-store job: 404 (BOLA). No decision: 422 `media_job_not_decided`. Already on another product: 409 `media_job_attached_elsewhere`. Storage not configured: 503.
- The attach is a compare-and-set on `product_media_jobs.attached_product_id` (one job, one product, safe under concurrency, idempotent for the same product). The chosen private object (white JPG for an accepted cutout, the scanned original for `use_original`) and the transparent PNG are copied once to the catalog image purpose (`catalog/yyyy/mm/uuid`, EXIF already stripped) and stored by key on `product_media` (`media_job_id`, `image_ref`, `cutout_ref`) and on the job (`promoted_*_ref`, buried with the job). Dropping the image from the product frees the job.
- Shopper and anonymous product responses: `image_url` (white JPG or original) and `cutout_url` (transparent PNG, accepted cutouts only), as short-lived signed links through the same media resolver as every other product image, and only while the product is active. Job keys (`product-media/…`) never appear.
- Seller wire: `image_media_job_ids` lists the entries of `image_upload_ids` that are job ids; the job wire carries `attached_product_id` (the seller console shows "Attached to product").
