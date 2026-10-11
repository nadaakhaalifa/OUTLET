# Admin Console web, Phase 2 screens (spec sections 9, 14, 15, 16, 19, 21, 22, 23, T8, T10; ADR-0028)

Extends `admin-console-web.md`. Same rules: the API is the authority, Zod at the boundary, reason-coded sensitive writes, server clock for deadlines, no sample data. No new tables.

## Screens
| Route | Content | API used |
|---|---|---|
| `/plus` | Versioned plans grouped by code; form validated for plan code, price (EGP text to integer piastres), trial 0-60 and an effective date at least 30 days after the server clock. Two steps: request a `plan_price_change` approval (approved by another person in `/approvals`; requester cannot approve), then publish with the approved ID. Activate/deactivate with reason code. Pause and cancel metrics shown as "not measured". | `GET/POST /v1/admin/plus/plans`, `PATCH .../{planId}`, `POST /v1/admin/approvals` |
| `/gift-cards` | `kill.gift_card_sales` and `kill.gift_card_redemption` as Allowed/Blocked (default Blocked). Void form. Group-pot reconciliation and fraud throttle events: explicit "no read endpoint" notes. | flags, `POST /v1/gift-cards/{id}/void` |
| `/rewards` | Coin conversion, tier thresholds (strictly increasing), max coins per event; the PUT re-reads the config and merges so no field is dropped. Odds editor per game (`daily_spin`, `scratch_card`): percent with up to 4 decimals stored as ppm; sum must be exactly 100% (a losing row is a listed row); coin/voucher outcomes need coins/template; publish disabled and reasons announced until valid; server action re-validates. Games switch state. | `GET/PUT /v1/admin/rewards/config`, `POST /v1/admin/games/{game}/odds` |
| `/calendar` | White Friday (last Friday of November, 3 days), 11.11, Mother's Day 21 March, Ramadan, Eid al-Fitr, Eid al-Adha. Cairo midnight with the real DST offset. Hijri events come from the Umm al-Qura calendar via ICU and are labelled "estimated, confirm after moon sighting". Release freeze starts 48 h before an event: upcoming, freeze, running. A banner shows while a freeze applies. Link to `/promotions`. Dates are computed locally, not stored. | none |
| `/drops` | Allowed/Blocked for `kill.drops`, `kill.waiting_room`, `kill.mystery_box` and the six drop types. Pause, resume, end a drop by ID; the dialog states the effect in words. Queue depth, bot block rate, admission health: "not measured". | flags, `POST /v1/admin/drops/{id}/pause` |
| `/price-matching` | tau (basis points shown as %), shadow-only flag, labelled pairs vs the 2,000-pair target, kappa. `kill.crawlers` state. SSRF/robots incidents: no endpoint. Link to the enforcement ladder log (`/price-integrity`). | `GET /v1/admin/price-matching/config`, flags |
| `/ads` | Sponsored-products config and the invalid-traffic limits; `kill.sponsored_products` state. Invalid-click review queue: no endpoint. | `GET /v1/admin/ads/config`, flags |
| `/resale-hub` | `kill.resale_lane`, `kill.hub_consolidation` state. Listings and consolidations: no admin read endpoint. | flags |
| `/engineering` | Load a `dora-report.json` (`outlet.dora.report/v1`) by paste or file; Zod-parsed in the browser, never uploaded. `basis` and `source.deploymentProxy` next to numbers; a proxy shows a notice; `null` renders "Not measured". Cost per order, cost per 1,000 sessions and gCO2e per order are "Not measured" placeholders. | none |
| `/flags` | Every kill switch (core 14 plus the 24 Phase 2 switches from `packages/feature-flags`) grouped, shown **Allowed** or **Blocked** (ADR-0028). The change dialog states the resulting state and effect in words ("After this change, Gift card redemption will be Blocked. Effect: Redemption answers 503."). Keys the server did not report are listed as Blocked (fail closed). | `GET /v1/admin/flags`, `PUT /v1/admin/flags/{key}` |

## Rules
- Wording: never "kill switch on/off"; a copy test scans both catalogs.
- Odds: `probability_ppm` integers, sum exactly 1,000,000; the same pure validator runs in the editor and in the server action.
- Money: EGP text to `bigint` piastres, no floats. Plus notice: `effective_from >= server now + 30 days`; the API enforces it too (`notice_too_short`).
- Posture: all writes disabled when posture is not ok, as in phase 1.

## Failure handling and states
Each screen has loading (server render), empty, error (ErrorBlock with request ID), offline and forbidden states through `ErrorBlock`; a missing endpoint is a note, never invented data.

## Security
Server actions re-validate with Zod, send `Idempotency-Key`, redirect with a flash code. Approval IDs are entered by the operator; the API verifies kind, subject, amount and that approver differs from requester.

## Acceptance
`apps/admin-web/src/view-models/phase2.test.ts` (22 tests): key list pinned to `PHASE2_KILL_SWITCHES`, Allowed/Blocked wording and fail-closed, 30-day notice boundary, odds sum property (valid iff exactly 100%), tier ordering, calendar dates and 48 h freeze boundary, DORA null handling, nav by role.

## Gaps
1. No read endpoints: Plus pause/cancel metrics, gift-card pot reconciliation and throttle events, drop queue depth/bot rate/admission, crawler SSRF/robots incidents, invalid-traffic queue, resale listings and hub consolidations, promotions calendar storage. Shown as explicit notes.
2. `POST /v1/gift-cards/{id}/void` is owner-scoped (404 for others): admin void needs an admin route.
3. `PUT /v1/admin/ads/config`, tau change and promotion writes have no UI (read-only) because an approval-bound design is not specified.
4. Rewards `approval_id` is a free string on the wire; the UI sends what the operator enters.
5. Hijri event dates are astronomical estimates. No browser E2E was run.
