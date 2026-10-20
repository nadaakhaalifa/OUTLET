# ADR-0050: Every OpenAPI path is served or marked planned

- Status: **Accepted (engineering default; reversible)** for the ratchet and the per-path decisions, except four items that wait for an owner: seller balance hold reasons; price-integrity config writes; deleting the three security-relevant paths in decision 3 (Proposed, owner decision on mapping-test evidence); replacing `/v1/seller/analytics/summary` (Proposed, product sign-off). Amended 2026-10-16 after the chief-reviewer security and privacy review (M3, L5).
- Date: 2026-10-16
- Deciders: Architect, Tech Lead; Security (allow-list owner); Owner (decision 3); Product (decision 4)
- Spec refs: `docs/specs/dashboard-foundations.md` sections 7.3, 8 and 12; master prompt T5 (API9 inventory: no shadow endpoints); VR-AC-03; ADR-0021 (dual approval thresholds); `research_notes/Seller and admin dashboards benchmark/repo_api_data.md` section 1

## Context and problem statement
Several OpenAPI operations have no Nest route. Some are called by the web apps (`/v1/seller/balance`, `/v1/seller/statements`, `/v1/seller/team*`, `/v1/admin/reconciliation/breaks`, `/v1/admin/price-integrity/actions`) or mobile (`/v1/seller/analytics/summary` and `/v1/seller/balance`, both from one `Promise.all` in `apps/mobile/src/features/brand-mode/api.ts:119-120`, so the Brand-mode dashboard fails as a whole) and so fail against the real API. The generated client advertises them as available. The seller team contract also uses a role vocabulary (`fulfilment`, no `support`) that the server does not accept. The reverse problem (a served route with no contract, API9 shadow endpoint) has no check either.

## Decision
1. **Planned operations** carry `x-status: planned`, `x-spec-ref` and `x-planned-until` (phase label or ISO date) **and** are listed in `docs/api/planned-operations.yaml`, owned in `CODEOWNERS` by Security and the Architect. The generated client emits them as `notImplemented` stubs (same types, no network call, `{ ok: false, error: "not_implemented" }`).
2. **Ratchet tests in CI, both directions:** an OpenAPI operation with no Nest route and no planned marker fails; a planned operation that gains a Nest route fails until its marker and allow-list entry are removed in the same PR; a Nest route served by the booted app with no OpenAPI operation fails (API9); an `x-planned-until` in the past fails.
3. Superseded paths are deleted and their callers repointed in the contract PR: `/v1/seller/statements`, `/v1/seller/team*`, `/v1/admin/reconciliation/breaks`, `/v1/admin/sellers`, `/v1/admin/sellers/{storeId}/kyc`, `/kyc-decision`, `/v1/admin/tax/invoices`. **Not in that PR:** `/v1/admin/refunds/{id}/approval`, `/v1/admin/payouts/{id}/approval` and `/v1/admin/sellers/{storeId}/suspend` stay as planned stubs with `x-replaced-by` until HTTP tests show that the superseding routes (`/v1/admin/approvals*`, `/v1/admin/finance/payouts/{id}/approve`, the KYC suspension routes) enforce the same roles, passkey and **dual-approval thresholds** as ADR-0021 (boundary amount and threshold minus one piastre, distinct second approver, self-approval refused, one threshold constant) and the suspension human review; deletion is then the owner's decision.
4. Replaced: `/v1/seller/stores/{storeId}/analytics/summary` is added; the old `/v1/seller/analytics/summary` stays `deprecated` and planned with `x-replaced-by`. The new response is not a drop-in (tiles of `MetricSeries` with instant windows instead of `freshness_at, gmv, orders` with Cairo dates), so removing the old path and repointing mobile Brand mode need **product sign-off**.
5. Built: `/v1/admin/audit-log` (Phase A). Planned with specs: `/v1/seller/stores/{storeId}/balance` (Phase B), `/v1/admin/price-integrity/actions` and GET config (Phase C), `/v1/admin/order-groups/{id}` and `/v1/admin/disputes/{id}/resolve` (Phase C, CR checkpoint for the dispute money path). `PUT /v1/admin/price-integrity/config` stays planned until the owner sets enforcement parameters.
6. `TeamMember.role` moves to the policy vocabulary (`owner, manager, catalog, warehouse, finance, support`) by expand and contract; seller-web labels `warehouse` as "Fulfilment / التجهيز". Naming only; no permission changes.

## Options compared
- Per path: build every path vs delete every unserved path vs decide per path (chosen). Building all duplicates routes that already exist under better names (KYC, approvals, tax documents, store-scoped statements); deleting all would drop planned surfaces that have a spec. Per-path decisions keep one route per capability.
- Planned operations in the client: drop them (simpler, but every caller deletes and later re-adds code) vs `notImplemented` stubs (chosen; types stay stable and no request can be sent).
- Security-relevant deletions: delete now on the basis that thresholds are "unchanged" (draft) vs delete only after mapping tests prove it (chosen). A dual-approval regression would move money; evidence first.

## Consequences
The generated client shrinks; web pages that silently 404 today either work (repointed) or show an honest "not available yet" state for planned paths. Shadow endpoints are caught in CI. Three security-relevant and one mobile path stay in the contract as planned stubs for one more phase.

## Owner decision required
- Owner (Finance, Trust and Safety): delete the three paths in decision 3 once the mapping tests are green. Safe default: planned stubs.
- Product: replace the unscoped summary for mobile Brand mode (decision 4). Safe default: both paths in the contract, old one deprecated.
