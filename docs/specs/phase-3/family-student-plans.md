# Spec P3-03: Family and student plans (Plus)

Refs: §14 plan table (Family P2->P3, Student P2->P3), §B6, §B7, ADR-0004, ADR-0012, VR-08, VR-P3-09. Extends the `subscriptions` module (plans, entitlements, `PersonKeyPort`, dunning, proration). The existing Phase 2 module covers monthly, yearly and gift plans; family and student are new `plans.code` values and a seat model.
Status: domain and fakes buildable now; real student verification and live billing wait on VR-P3-09 and, as for Plus, VR-P2-01/02 and App Review (Plan A or B).

## Flow
Family: owner subscribes to Family (1,200 EGP per year default, up to 4 adults, all 18+ with own accounts) -> invites by phone (OTP-verified invite link) -> each invitee accepts, gets Plus entitlements on their own account -> owner sees seats and can remove a member; a member can leave.
Student: shopper starts verification with a university email OTP or a third-party verifier session -> `student_verified_until` set (12 months, re-verify) -> student price plan purchasable (discount configured by admin with audit) -> entitlements identical to Plus.

## Rules
- Prices are admin-configurable and versioned; price changes notify members >= 30 days ahead (§23). Numbers above are defaults from the spec, not decisions.
- Family: seats max 4 adults including owner (configurable); each member must be 18+ and satisfy the Plus age policy (default 21, ADR-0012: members below the gate cannot be added while the gate is 21; show why). Owner is the billing party and legal contracting party; members receive benefits only. A user can belong to one family at a time. Leaving or removal frees the seat **at the next cycle** (per §14), benefits end at the member's removal effective date = period end.
- Benefits are commerce-only (Plan A). If App Review forces Plan B, entitlement groups are already split (Phase 2) and family seats map to the commerce group.
- Free trial: one per person across plan types (phone + device + card fingerprint, existing `PersonKeyPort`); a family seat does not consume or grant a trial.
- Student: eligibility proof stored as a verifier result reference and an expiry only (no ID images held by us). No student discount without a verified, unexpired status; lapse -> price reverts at next renewal with 30-day notice, never silent.
- Savings meter and "pay 4 get 8" copy apply only to plans where the arithmetic is true; unit-tested per plan.
- Refunds, dunning and grace follow Plus rules (7-day grace, day 1/3/7).
- Seats and free delivery are per member order; a member's order never exposes another member's address or orders to the owner.

## Edge cases
Owner cancels -> all seats end at period end with notice to members; owner account deleted -> plan terminated, pro-rata per refund policy, members notified; member removed mid-order -> benefits already applied to placed orders stay; member invited who already has Plus -> choose to keep own or join (their own plan ends at period end, no double charge); phone change; invite expiry 7 days; invite abuse (selling seats): invite rate limit and a member-churn limit (max 2 seat changes per 90 days); same person in two families rejected; plan switch Family <-> yearly proration via existing calculator extended and property-tested; student verifier outage -> pending state, no charge at student price; graduation; non-Egyptian university domains need an allow-list policy.

## Data
`family_groups(id, owner_user_id, subscription_id, seat_limit, status)` · `family_members(group_id, user_id, role owner|member, status invited|active|removed, seat_effective_from, seat_end_at)` · `family_invites(id, group_id, invitee_phone_hash, token_hash, expires_at, accepted_at)` · `student_verifications(user_id, verifier, ref, verified_at, valid_until)` P2. Extend `plans` with `kind` and `seat_limit`.

## API
`POST /v1/plus/family` · `POST /v1/plus/family/invites` · `POST /v1/plus/family/invites/{token}/accept` · `DELETE /v1/plus/family/members/{id}` · `POST /v1/plus/family/leave` · `POST /v1/plus/student/verify` · `POST /v1/plus/student/verify/callback` (verifier HMAC) · existing subscribe/cancel/pause. All writes idempotent; owner or member scope enforced; rate limits 10/min.

## Events
`family.created`, `family.member_added/removed`, `student.verified/expired`; analytics `family_invite_sent`, `family_invite_accepted`, `student_verified`. Entitlement changes flow through the existing `EntitlementRow` projection.

## Failure handling
Invite acceptance and seat counting under a row lock or unique constraint (no seat oversubscription under concurrency); verifier callback idempotent by verifier ref; billing failures follow dunning; entitlement projection rebuildable from subscription and membership state.

## Security and abuse
Invite tokens 128-bit hashed with expiry; accept requires OTP-verified identity on the invitee account; BOLA on every group route; verifier callbacks signed and replay-protected; seat-trading and trial farming controls above; family data minimised (members see names or nickname only if the owner enabled it).

## Metrics
Family attach rate, seats filled per group, student conversion, churn by plan, savings delivered vs fee per plan (target >= 2x median), seat-change abuse flags.

## Acceptance
```
Given a family of 4 and a fifth invite, then it is refused with a clear reason.
Given two concurrent accepts for the last seat, then exactly one succeeds.
Given a member removed on day 10, then benefits end at period_end and the seat is free the next cycle.
Given a 19-year-old member and Plus age gate 21, then the invite is blocked with the policy reason.
Given an expired student status at renewal, then the student price does not apply and a prior notice exists.
Property: no sequence of invite/accept/remove/leave leaves more active members than seat_limit.
```
