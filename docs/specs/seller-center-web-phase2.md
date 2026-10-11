# Seller Center web, Phase 2 screens

Status: implemented in `apps/seller-web` against `docs/api/openapi.yaml`. Builds on `docs/specs/seller-center-web.md` (typed client with Zod at the boundary, SessionPort, pure view-models, strict CSP, AR/EN with RTL).

## Screens and contracts

| Screen | Route | Reads | Writes (all send `Idempotency-Key`) |
|---|---|---|---|
| Sponsored products | `/ads` | `GET /v1/seller/ads/campaigns`, `/balance`, `/reports` | `POST /campaigns`, `/campaigns/{id}/pause`, `/resume`, `/topup` |
| Drop builder | `/drops` | `GET /v1/seller/drops` | `POST /drops`, `/drops/{id}/schedule`, `PATCH /drops/{id}` (stock only) |
| Open-box listings | `/resale` | `GET /v1/seller/stores/{id}/resale/listings` | `POST .../{id}/withdraw` |
| Insights (analytics v2) | `/insights` | `.../analytics/aging`, `.../analytics/size-curve` | none |
| Channels and price integrity | `/channels` | `GET /v1/seller/channels`, `/stores/{id}/crawl-targets`, `/v1/seller/price-trust` | `POST /v1/seller/channels` |
| Hub consolidation | `/hub?og=` | `GET /v1/me/orders/{id}/tracking` | none |

Every screen renders exactly one `ScreenState`: loading (`loading.tsx`), offline (transport `NetworkError` plus the offline banner), not configured, empty, error (403, 404, 429, contract drift, 5xx) or ready. Sections that fail on their own (ad report, balance, size curve, parity) degrade without hiding the rest.

## Rules enforced

1. **Sponsored labelling**: the screen lists the rules (labelled Sponsored, at most 2 in the top 10, same filters, blocked while a price enforcement action is active). `403 advertising_blocked` maps to a dedicated message. Ad prices are shown excluding VAT (`vat_inclusive: false`); top-ups list net, VAT and gross from the API.
2. **No fake numbers**: CTR, CPC, ROAS, sell-through and shares that the API reports as null (or that have no denominator) render "Not enough data", never zero. ROAS is formatted from basis points with integer math. A suppressed or missing value is never turned into 0.
3. **Drops**: all times are typed as Cairo wall-clock time and converted with `Intl` using the real Africa/Cairo offset (Egypt observes DST). Early access is allowed only on members-only drops and must start before the drop. Per-device limit cannot be below per-user. Price ladder next price must be lower than the start price. Mystery box needs min <= guaranteed <= max. After SCHEDULED, schedule, prices and limits are locked and only stock can be raised (checked in the view-model, again in the server action, and by the API via `version`). The drop start countdown uses the response `server_time` plus a monotonic timer, never the device clock. Sold-out drops show the waitlist explanation; the API exposes no seller waitlist data, so none is shown.
4. **Open-box**: the view-model has no reference/original price or percentage field, and a test asserts no value contains a percent sign. Sellers can withdraw available listings; creation is a hub operation (`POST /v1/hub/resale/listings`), so there is no create form.
5. **Insights**: the markdown note "a new price will not show a percent off unless Z-OUTLET verifies it" is always visible. If the server ever sets `shows_percent_off: true`, the suggested price is withheld and a notice is shown. The k-anonymity threshold comes from `meta.k_anonymity_min`; hidden groups are never shown as zero.
6. **Channels**: connect uses `POST /v1/seller/channels` (`pending_oauth` plus `connect_url`) through a `ChannelOAuthPort`. `RedirectOAuth` follows the URL only if it is https and on the shop's own domain (or `*.myshopify.com` for Shopify); `FakeChannelOAuth` is used in tests. The shop domain must be a bare hostname. The page never sees a token.
7. **Parity warnings**: a price-trust active action with `reason_code = cross_channel_cheaper` is shown with a 48 hour fix countdown (applied_at + 48 h, spec section 9.3) computed from the server `Date` header.

## Contract gaps (no screen invents data for these)

- **Crawl incident feed**: there is no endpoint. Incidents are derived only from read models: revoked or errored channels, unverified crawl targets, and targets whose robots check never ran.
- **Parity warnings**: there is no dedicated endpoint. They are derived from `GET /v1/seller/price-trust` actions with reason code `cross_channel_cheaper`. This reason code and the 48 h window are assumptions from the master prompt, to confirm with the API owner.
- **Stylist inclusion rate**: no seller endpoint exists. The card says it is not available and shows no figure.
- **Hub consolidation for sellers**: the only read contract is the shopper-scoped `GET /v1/me/orders/{orderGroupId}/tracking` (`shopper:orders.read`). A seller token will likely get 403, which renders the forbidden state. A seller-scoped listing is needed for a useful screen.
- **Size curve** is `additionalProperties: true` in the OpenAPI document. The Zod schema follows the controller wire (`apps/api/.../seller-analytics/adapters/wire.ts`); the OpenAPI schema should be tightened.
- **Top-up payment**: `client_action` (PSP redirect) is not handled yet; the action only creates the top-up and refreshes the page.
- **Drop edit and delete** beyond stock increase, and campaign edit (`PATCH`), have client or API support but no UI yet.
- Seller role is still unknown to the app (no seller "me"), so navigation shows all links and the API enforces access.

## Tests

`src/test/phase2.test.ts`: money and Cairo-time parsing (including a fast-check round trip and DST), ads, drops, resale, insights, channels, OAuth port, parity countdown, nav, loaders (ready, partial failure, offline, 403, contract drift, not configured, empty) and idempotent writes. i18n parity (AR/EN same keys and placeholders, Arabic letters) is covered by the existing `i18n.test.ts`. Architecture tests (no `any`, no non-null `!`, no inline style or script, no fetch outside transport) cover the new files.

## Not verified

No browser was available: layout, RTL rendering, focus order, keyboard use, screen-reader announcements and the external OAuth redirect (CSP `form-action 'self'` applies to form posts; server actions navigate via fetch, but this was not exercised) are unverified by a real browser or an axe run.
