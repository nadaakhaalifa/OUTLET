# ADR-0043: Wardrobe digitization: consent purpose, photo erasure and owned slots

- Status: **Accepted as safe default (engineering on synthetic data); vision vendor blocked on VR-P3-13**
- Date: 2026-10-12
- Deciders: Architect, DPO (review), Product
- Spec refs: §28 feature 4, §B1, §T6 (DPIA stylist risk 3), §T12, §11, ADR-0018, ADR-0002, spec P3-02 (outfit calendar)

## Context and problem statement
Shoppers can digitize garments they own (photo plus attributes) so the stylist completes outfits with owned pieces. Photos are P2 personal data and may show people or interiors. Four decisions: which consent purpose, how photos are erased on every deletion path, how owned items enter the optimizer, and what the vision port may do.

## Decision
1. **Consent purpose: reuse `personalization`.** ADR-0018 fixes nine purposes and says a tenth needs spec, migration, code, OpenAPI, i18n and apps together. `data_inventory.yaml` already tags `wardrobe_items` with `consent_purpose: personalization`. Writes and complete-from-wardrobe need the purpose granted and the personalization toggle on (403 `consent_required`); reading, exporting and deleting never need it. External vision residency additionally needs `cross_border_ml`. If counsel wants a dedicated purpose, add it through the ADR-0018 mechanism; no wardrobe code changes except the consent port adapter.
2. **Photo pipeline:** the existing private-bucket signed upload, scan state and EXIF/GPS stripping, with a new key scheme `wardrobe/yyyy/mm/uuid` (no user id, no file name). A photo is never read or served before the scanner tags it `clean`. Object keys are never in API responses; the photo is reached only through a 5 minute signed GET.
3. **Erasure never depends on application code paths.** `wardrobe_items` and unconsumed `wardrobe_uploads` have DELETE triggers that copy the object key into `wardrobe_blob_graveyard` (no user key, no personal data). A user delete removes the object at once; account erasure (which deletes rows by `user_id`) and retention fall back to the graveyard purge (1 day grace, blob-aware purge target). Abandoned uploads and infected items are purged by age after 1 day.
4. **Owned slots:** an owned garment becomes a locked, zero-price placeholder in the calendar's gap planner (`planGap`, which wraps the stylist optimizer and rules fallback). It is never part of the budget arithmetic or of an outfit total; a property test checks this over random wardrobes, catalogs and budgets. Selection is deterministic (best formality fit, then oldest, then id), honours modest mode only for items the shopper marked modest, and never mixes a dress with a top or bottom. The calendar's `owned_slots` stay user declared: the wardrobe exposes `GET /v1/me/wardrobe/owned-slots` as a suggestion the app may pass on.
5. **Vision is a suggestion, never a decision.** `VisionAttributePort` has a deterministic fake for tests and dev, and an Unconfigured production adapter that answers 503. A suggestion is applied only to an item the shopper has not edited, is flagged `needs_review`, and any edit by the shopper wins. Outputs are a closed vocabulary validated by Zod; no free text is stored.

## Options compared (2-3 lines)
- Dedicated `wardrobe` consent purpose vs reuse `personalization`: dedicated is more granular but touches nine surfaces including mobile; reuse matches the existing inventory tag and ships now.
- Delete objects in the request vs trigger-fed graveyard: request-only leaks objects on account erasure and crashes; graveyard is crash-safe and covers erasure by row deletion.

## Consequences
Good: no new purpose churn, erasure covers every path, owned items cannot affect money. Bad: erasure of an object after account deletion can lag up to one retention cycle; the DSAR archive lists items and attributes but does not embed photo bytes (ExporterPort carries rows only).

## Open items
VR-P3-13 (vision vendor residency and retention). DPIA stylist risk 3 and the open question on training use stay open: photos are never used for model improvement. Admin-web kill-switch labels for `kill.wardrobe` and `kill.wardrobe_vision` must be added by the admin-web owner.
