# Home offer banners (swipeable carousel on the shopper Home)

Status: backend built (module `apps/api/src/modules/home-banners`, migration 0084, kill switch `kill.home_banners`). Mobile and web UI are out of scope here.

## Flow
Marketing or ops creates a draft in the Admin Console, schedules it, may pause or resume it, and may preview the carousel as of a time. The shopper Home calls `GET /v1/home/banners` and renders the slides in order.

## Rules
- Visibility is decided by SERVER time only: `status = scheduled AND starts_at <= now < ends_at`. The API never reads a client clock.
- Order: priority descending, then earlier start, then id. At most 8 slides. No 3 consecutive slides hold more than 1 sponsored banner (a sponsored banner that cannot be spaced is dropped, never moved ahead of its turn).
- Sponsored banners carry an ads or finance reference (`sponsor_ref`, admin only) and the shopper payload says `sponsored: true`; the app must render the "Sponsored" / "إعلان" label.
- CTA is typed, never a URL: `drop | store | category | search | voucher` with an opaque id, a short plain-text query (URLs rejected) or integer-piastre price bounds (category and search only).
- Text: Arabic title required (<= 60), English optional; subtitle <= 120. Images are object-store keys only; `image_url` is derived and omitted when no media base is configured (the app draws `art_variant`).
- Window: start < end, at most 90 days. Scheduling or resuming an elapsed window is refused.
- Targeting: none. No budget, affordability or per-user financial signal may ever be an input (spec 12, 17). Coarse segments (governorate, locale, new vs returning, Plus) may be added later by a reviewed migration.

## Data (class P0/P1, no personal data)
`home_banners` (migration 0084, expand only, RLS: shoppers read scheduled rows, marketing/ops/system write). Inventory: `docs/privacy/data_inventory.yaml`.

## API
| Route | Audience | Notes |
|---|---|---|
| `GET /v1/home/banners` | shopper | ETag over items, `Cache-Control: private, max-age=30`, empty list when the kill switch is blocked |
| `GET/POST /v1/admin/home-banners`, `GET /preview`, `GET/PATCH/DELETE /:id`, `POST /:id/{schedule,pause,resume}` | admin (passkey; roles marketing, ops) | Idempotency-Key on writes, If-Match required on PATCH, audit row written before the change (failure answers 503, nothing written) |

## Events and metrics
Impression and click counters are NOT emitted: the analytics taxonomy has no typed banner event yet. Add `home_banner_viewed` and `home_banner_clicked` (id, position, sponsored) to the taxonomy before the app sends them.

## Failure handling
Kill switch blocked: shopper read answers 200 with an empty list (Home hides the carousel). Audit down: admin writes answer 503.
