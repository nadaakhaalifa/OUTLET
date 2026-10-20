# ADR-0047: Analytics buckets in Africa/Cairo; display time zone, week start and RTL time axis

- Status: **Proposed.** Bucketing in Africa/Cairo is the engineering default and may be built for ungated metrics; how days are *displayed*, the week start and the time-axis direction in RTL charts are owner and Arabic UX reviewer decisions. Moving **shopper-gated** reads (legacy and series) to the Cairo grid is part of the DPO decision in ADR-0045 decision 4 (VR-DASH-02, VR-DASH-05). Amended 2026-10-16 after the chief-reviewer security and privacy review (B1, B2).
- Date: 2026-10-16
- Deciders: Owner (Product), Arabic UX reviewer, Architect; DPO (gated reads)
- Spec refs: `docs/specs/dashboard-foundations.md` track 4; benchmark report section 6.1 and section 9; master prompt 17 (Cairo TZ for promotions), 24 (quiet hours Africa/Cairo); `apps/api/src/workers/cairo.ts`

## Context and problem statement
Seller analytics snaps windows to UTC days (`snapToDays`, `packages/domain/src/seller-analytics/kanon.ts:87-94`, used by every legacy route through `seller-analytics/application/queries.ts:49`), so a Cairo seller's "today" starts at 02:00 or 03:00 local. Egypt observes DST again since 2023 (last Friday of April 00:00 to 01:00; last Thursday of October 24:00 back to 23:00), so a local day has 23, 24 or 25 hours and the spring day has no 00:00 hour. RTL chart direction has no consensus in the sources found. The review added a privacy constraint: two shopper-gated reads with different day boundaries over the same facts can be subtracted to isolate the boundary hours, so gated reads must never mix UTC and Cairo windows.

## Decision (defaults)
1. Buckets are computed in Africa/Cairo: hour = one UTC hour labelled with the local hour, offset and fold; day = all hours with that local date (23, 24 or 25); week = 7 local days starting **Saturday**; month = local month. Responses carry `tz: "Africa/Cairo"`, `hours`, `offset_min` and `fold`.
2. Display: dates and "today" in Cairo time with a visible "Cairo time / بتوقيت القاهرة" label on every chart and tile.
3. **One window function for every shopper-gated read** (`gatedWindow` in `packages/domain/src/time/cairo.ts`). Gated reads, legacy and series, switch from UTC to the Cairo grid **in one release**, the one that allows `release.seller_analytics.shopper_series` (DPO). Until then legacy routes that carry gated fields stay entirely on UTC days, so no response and no pair of gated reads mixes the two. Ungated series use Cairo buckets under `release.seller_analytics.series`; the store-scoped summary tiles come from them. When the gated switch happens the legacy numbers change by up to one boundary hour per day and the change is announced in the seller changelog.
4. **Gated metrics use a fixed grid:** complete Cairo days and complete months, presets `month:YYYY-MM`, `last_full_months:{1,3,6,12}`, `current_month` (no margins). Weeks are not offered for gated metrics because a Saturday week straddles month boundaries (non-nested margins); ungated metrics keep weeks.
5. The series contract is ordered oldest first and is direction-neutral. Axis direction in Arabic is not decided here; the chart spike renders both for the reviewer.

## Options compared
- Cairo buckets (chosen) vs UTC buckets with Cairo labels. UTC buckets are simpler but misattribute two or three hours of every local day, which sellers will notice at day boundaries and during drops; Cairo buckets cost a DST-aware helper that already exists.
- Switching gated reads: per route as each is touched (rejected: creates the mixed-boundary differencing channel) vs one release behind the DPO flag (chosen).
- Week start Saturday (chosen default) vs Sunday (business week) vs Monday (ISO). Saturday follows the Friday-Saturday weekend; this is a display convention and easy to change.

## Owner decision required
- Owner and Arabic UX reviewer: confirm Cairo display, the week start and the RTL time-axis direction. Safe default: as above. Tz rule stability is VR-DASH-01.
- DPO: the gated switch (decisions 3 and 4) is decided together with ADR-0045 decision 4 (VR-DASH-02, VR-DASH-05). Safe default: gated reads stay on UTC days with the legacy rules; gated series blocked.
