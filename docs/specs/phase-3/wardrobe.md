# Spec: Wardrobe digitization (backend)

Refs: §28 feature 4, §11 (stylist), §B1, ADR-0043, spec P3-02 (outfit calendar), VR-P3-13.
Status: buildable now. Manual entry works end to end; photo suggestions sit behind `VisionAttributePort` (fake in tests, Unconfigured in production).

## Flow
Me > Wardrobe: add a garment by hand (category, colours, pattern, formality, seasons, material, modest) or by photo (signed upload, scan, then attributes by hand or a reviewed suggestion). "Complete from my wardrobe": pick an occasion; owned pieces fill their slots at zero cost and the stylist buys only the rest within budget.

## Rules
- Consent: `personalization` for writes and completion; reads and deletes always allowed.
- Caps: 300 items, 20 unused uploads, 10 MB per photo (jpeg, png, webp), 50 per page, completion shares the stylist's 30 per day.
- Attributes are a closed vocabulary; unknown fields are refused.
- Owned slots never count against the budget or an outfit total.
- Photo never served before scan `clean`; keys never in responses.

## API (all `/v1/me/wardrobe`, shopper audience)
`GET items` · `POST items` (idem) · `POST uploads` (idem) · `GET items/{id}` · `PATCH items/{id}` (idem) · `DELETE items/{id}` (idem) · `GET items/{id}/photo` · `POST items/{id}/suggest-attributes` (idem) · `GET owned-slots` · `POST complete` (idem) · `DELETE /` (idem).

## Failure handling
503 `wardrobe_disabled` (kill.wardrobe), `wardrobe_vision_disabled`, `wardrobe_vision_unconfigured`, `wardrobe_storage_unconfigured`, `catalog_unavailable`. 409 `wardrobe_full`, `too_many_pending_uploads`, `version_conflict`, `attributes_edited`, `photo_not_ready`. 422 `upload_unavailable`, `upload_rejected`, `nothing_owned`.

## Data (migrations 0081, 0082)
`wardrobe_items` (P2), `wardrobe_uploads` (P2), `wardrobe_blob_graveyard` (no personal data). RLS owner scoped; graveyard system only. Retention rule `user_content`.

## Security and abuse
BOLA: another shopper's item and upload ids answer 404 or 422 and never confirm existence. LLM: no model sees free text; vision output is schema validated. SSRF/XSS: no URL or markup field exists. Photos are never used for training.

## Acceptance
See `apps/api/src/modules/wardrobe/wardrobe.http.test.ts`, `domain.test.ts` (budget property), `adapters/kysely-store.pglite.test.ts` (erasure trigger, RLS).
