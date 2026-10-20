# ADR-0049: Role and visibility decisions raised by the dashboards

- Status: **Proposed.** Every item is an owner decision (role permissions, payout visibility). The safe default for each is built; nothing here grants a role a permission the policy does not already give it, except the admin metrics defaults in item 3, which are a new read and are therefore the most restrictive reasonable set. Amended 2026-10-16 after the chief-reviewer security and privacy review (M7: items 9-11).
- Date: 2026-10-16
- Deciders: Owner, Finance, Security, DPO
- Spec refs: `docs/specs/dashboard-foundations.md` tracks 1-4 and 7; benchmark report section 4.1, 4.2 and section 9; ADR-0021 (money design); `packages/policy/src/rules.ts`

## Context
The benchmark's role-by-metric matrix departs from the current grants in several places. The brief for this spec also asked for the ledger integrity route to be readable by "finance and security", which the policy does not grant today.

## Items and safe defaults
| # | Decision | Safe default (built) | Option for the owner |
|---|---|---|---|
| 1 | Who reads `GET /v1/admin/ledger/integrity` | Finance only, same gate as the ledger read API (standing grant plus passkey) | Add Security (status fields only, or the full report) |
| 2 | Ledger gate counts standing grants only, not elevations | Keep (stricter than the admin module) | Accept elevations for finance reads |
| 3 | Admin metrics roles | Counts: ops, finance. Money: finance. Passkey required | Widen (for example Marketing for funnel counts, CAC/LTV later) |
| 4 | Seller analytics resource | Keep borrowing `store_order` read and `store_settings` read | Introduce `store_analytics` with its own role list |
| 5 | Seller finance versus fulfilment views | Nav from existing permissions only | Reorder or restrict per role |
| 6 | Payout visibility to sellers: hold reasons, next payout date, net payable on the home | Not shown; seller summary uses net after commission | Show reasons and dates (extends ADR-0021; Seller Agreement wording VERIFY) |
| 7 | `ip_hash` and `device_id` in the audit-log list | Never returned | Return to Security only |
| 8 | Who sees outbox dead-letter counts in the attention queue | ops, security, super_admin (the flag readers) | Add Finance for money event types |
| 9 | The tax gate counts a **standing** `super_admin` grant (`tax-eta.controller.ts:62-63, 100-125`), while `computeAccess` counts standing super_admin only during break-glass | Report as built: `tax.read` capability mirrors the tax gate exactly; no gate change in the dashboards work | Align the tax gate with break-glass (stricter), or keep |
| 10 | Attention items for reconciliation, tax and brand applications | Each item uses the capability of the page it links to: `recon.read` (finance, ops), `tax.read` (finance, ops, super_admin), `brand_review.read` (ops, trust_safety). These mirror existing gates; no new access | Restrict an item further (for example tax rejects to finance only) |
| 11 | Attention thresholds tied to legal clocks (DSAR at 23 of 30 days; breach 72 h from detection) | As stated, one config constant (DPO-editable); depends on VR-01 and VR-DB-01 | Other thresholds once the statutory clocks are confirmed |

## Options compared (item 1)
Finance only (chosen default) vs Finance and Security. Security needs to know that integrity failed, which the Prometheus page already tells them out of band; reading balances and drift rows is a finance function. Adding Security is a role change and therefore the owner's call.

## Owner decision required
Each row above. Until answered, the defaults stay in code and the capability map in `GET /v1/admin/me` reports them faithfully.
