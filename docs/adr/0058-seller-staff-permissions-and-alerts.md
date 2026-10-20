# ADR-0058: Seller staff permissions as a code-owned permission catalogue with preset bundles; derived product availability with a SCHEDULED listing state; per-member seller alerts; consent-gated single bag reminder

- Status: **Proposed** (owner decisions T-D1 to T-D12 and VR-TEAM-01..12 open; nothing is built)
- Date: 2026-10-18
- Deciders: Owner (presets, seats, sensitive-grant approval model, reminder ladder, seller opt-out, labels, channels), Counsel and DPO (reminder classification, purpose, WhatsApp categories, Apple 4.5.4, staff age, staff data, ownership transfer, CPL claims), Architect (model). **Chief-reviewer checkpoint** on the policy change (authorization) and the ledger-backed finance summary before merge.
- Spec: `docs/specs/seller-teams-availability-alerts.md`
- Spec refs: master prompt 5, 6, 12, 16, 18, 19, 19.1, 20.2, 24, A2.6, A2.12, A2.13, B1, B5, B6, B7, T5
- Related: ADR-0005 (row-per-unit inventory), ADR-0018 (consent purposes, no SMS marketing), ADR-0031 (separate seller identity), ADR-0034 (comms providers), ADR-0047 (Cairo buckets), ADR-0049 (seller permission keys, `store_analytics`), ADR-0055 (guest bag device-only), ADR-0056 (`team.max_seats`, `store_restrictions`, fail-closed entitlements), ADR-0057 (store branding)

## Context
The owner asked for staff teams with roles such as manager, sales and marketing, the ability to give any permission to any staff member, restock and "mark sold out / coming soon", stock-out alerts with mute and push, revenue and growth tracking, and SHEIN-style reminders to shoppers who leave their bags. The repo has six fixed seller roles enforced by role lists in `packages/policy/src/rules.ts`, two parallel invite tables (`seller_staff_invites` in 0053, `seller_team_invites` in 0055), store-level (not per-person) notification preferences, no seller push tokens, product statuses `DRAFT, ACTIVE, PAUSED, DELISTED`, and a notifications core with marketing consent, quiet hours (23:00 to 09:00 Cairo) and caps (1/day, 3/week). Master prompt section 24 says "bag reminder (once)".

## Decision
1. **Permissions.** A code-owned catalogue of fine-grained keys (e.g. `products.write`, `stock.write`, `orders.fulfil`, `finance.view`, `store.branding`, `team.manage`, `promotions.write`, `analytics.view`, `ads.manage`), each mapped to a policy resource/action. Preset roles (Owner, Manager, Sales/Orders, Marketing, Catalogue and inventory, Warehouse, Finance, Support) are versioned bundles; each membership stores an explicit permission set (preset or customised). New policy grant kind `brand_permission`. Existing members migrate to presets with **identical** decisions (property-tested).
2. **No escalation.** A granter can grant only keys they hold; sensitive keys (payout account, billing, ads funding, team management, store closure) only by an owner with step-up; nobody edits their own permissions; last-owner protection; ownership transfer is offer + accept (two steps, never zero owners); legal signatory is a separate KYC fact (21+ default, B6).
3. **Sensitive grants** need a second owner's approval; single-owner stores get a 24 h delayed activation with notice on every device and email (default; T-D4).
4. **Enforcement:** guard reads effective permissions (membership ∩ store restrictions ∩ entitlements) from a projection invalidated within 5 s; permissions are never in the JWT; RLS remains the tenant boundary; foreign store = 404, missing permission = 403.
5. **Seats** enforced at invite and accept from ADR-0056 `team.max_seats`, fail closed to the fallback plan; one invite table with phone (and optionally email, T-D5) contact, 72 h, single use.
6. **Availability = listing status (stored) + availability (derived from inventory counters).** Add `SCHEDULED` (coming soon, optional `launch_at`, automatic launch job). "Mark sold out" is a real stock adjustment to zero free units (reason `marked_sold_out`), never a display flag; pausing shows "Currently unavailable", never "sold out". Countdown only for automatic launches within 7 days, server-time synced, and never after a second postponement. Back-in-stock fires only on an `on_hand` increase, debounced, with FIFO waitlist batches sized to real stock.
7. **Seller alerts** per member with store defaults, mutes (snooze), quiet hours (default 23:00 to 09:00 Cairo), digest, coalescing and a per-member rate limit; critical alerts (SLA warnings, price-integrity auto-pause risk) cannot be silenced unless another reachable member covers them; security alerts are never muted. Separate `seller_push_tokens` (seller identity is separate, ADR-0031). Alert payloads carry no buyer personal data.
8. **Revenue:** gross, delivered, refunds, net sales (analytics) are distinct from net earnings (ledger truth = statement); growth in basis points, null when the previous period is 0; repeat rate and demographic cells keep k >= 50.
9. **Shopper reminders** are platform-sent, treated as **marketing** (channel consent, quiet hours, caps, one-tap unsubscribe) until counsel says otherwise; **one** bag reminder per episode by default (master prompt 24). A multi-step ladder (e.g. 1 h / 24 h / 72 h) is available only by owner decision T-D6 and a dual-approved `reminder_policy` change, still under caps and quiet hours, and is a recorded deviation from master prompt 24. Content states only facts true at render time; no timers, no "reserved for you"; sellers never see shopper identities from bags or waitlists. 10% holdout. Kill switches `kill.bag_reminders`, `kill.back_in_stock_alerts`, `kill.seller_push`, default blocked.

## Options compared
- **Permission model.** (a) More fixed roles: cannot meet "any permission to any staff". (b) Catalogue + presets + per-member sets: chosen; least privilege, testable, auditable. (c) Seller-authored ABAC rules: expressive but cannot be covered by the negative-authorization matrix.
- **Sensitive grant approval.** (a) Owner + step-up: instant takeover risk. (b) Second owner or 24 h delayed activation: chosen. (c) Platform Ops approval: staff cost per grant.
- **Availability.** (a) One stored enum mixing lifecycle and stock: goes stale, write storms. (b) Stored intent + derived stock availability: chosen, cannot disagree with checkout.
- **Manual sold out.** (a) Display flag: false scarcity (A2.13). (b) Stock to zero: chosen. (c) Pause: offered, labelled "unavailable".
- **Alert preferences.** (a) Per store (today): one person silences everyone. (b) Per member with owner defaults and critical coverage: chosen.
- **Reminder classification.** (a) Transactional: legal exposure if wrong. (b) Marketing: chosen as the safe, reversible default.

## Owner and counsel decisions (block acceptance)
T-D1 preset names and contents · T-D2 custom sets on every plan (default yes) · T-D3 seats per tier, what counts · T-D4 sensitive-grant approval model · T-D5 email invites · T-D6 bag reminder once vs ladder, first delay · T-D7 seller opt-out from reminders, aggregate counts to sellers · T-D8 restock-expected label · T-D9 countdowns at all · T-D10 alert thresholds and windows · T-D11 holdout · T-D12 seller alert channels and cost. Counsel/DPO: VR-TEAM-01..12.

## Consequences
- Policy package gains a permission catalogue and a new grant kind; every seller route moves from role lists to permission keys in one PR per module, each with negative rows (spec 1.15). Chief-reviewer checkpoint on the policy change.
- Expand/contract migration consolidates the two invite tables; `seller_memberships.role` stays for compatibility until readers move.
- Catalog gains `SCHEDULED`, `launch_at`, a launch job and an availability projection feeding search; inventory (ADR-0005) is unchanged, mark sold out reuses the stock route.
- Notifications gain `BAG_REMINDERS` (switchable marketing type), product alert kinds `back_in_stock` and `launch`, render-at-release for deferred reminders, and a seller alert pipeline with its own push tokens and inbox.
- Seller-analytics gains growth objects; finance summary reads the ledger; a nightly facts-vs-ledger commission check is added.
- Deviation from master prompt 24 "bag reminder (once)" only if T-D6 enables the ladder; recorded here when decided.
