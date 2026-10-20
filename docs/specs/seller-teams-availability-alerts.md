# Seller teams and permissions, product availability, seller alerts, revenue tracking, shopper bag and back-in-stock reminders

Status: **Draft design, not built.** ADR-0058 (Proposed). Template: master prompt A3. Spec refs: 5, 6, 8, 12 (budget never used), 15.4 (fraud graph), 16 (truthful social proof), 18, 19, 19.1, 20.2, 23, 24, 26, A2.6, A2.12, A2.13, B1, B5, B6, B7, T2, T3, T5, T8.
Builds on (grep-verified 2026-10-18): `seller_memberships` and `seller_staff_invites` (migration 0053, `apps/api/src/modules/auth/seller`), `seller_team_invites` and `seller_notification_prefs` (migration 0055, `apps/api/src/modules/seller-settings`), `packages/policy/src/rules.ts` and `seller-permissions.ts` (role-based brand rules, ADR-0049 keys), `docs/specs/inventory.md` (ADR-0005), `docs/specs/catalog.md` (product status `DRAFT, ACTIVE, PAUSED, DELISTED` + `auto_paused_price_parity`), `docs/specs/notifications.md` (rules N1 to N18, `decideChannel`), `docs/specs/cart.md`, `docs/specs/seller-analytics.md` (k >= 50), ADR-0056 (entitlement `team.max_seats`, `store_restrictions`, fail-closed entitlements), ADR-0047 (Cairo buckets), ADR-0055 (guest bag is device-only).

Owner request (intent): teams with roles such as manager, sales, marketing; restock; mark sold out / coming soon; give any permission to any staff member; total revenue and growth; alerts when products sell out; mute notifications; push notifications; remind shoppers who leave their bags "like SHEIN does".

Nothing in this document is a legal position. Every legal question is a VR-TEAM row (section 9); every product choice that is not a safe default is an owner decision (section 10).

---

## 0. What exists and what this changes

| Area | Today | Gap this spec closes |
|---|---|---|
| Roles | 6 fixed roles `owner, manager, catalog, warehouse, finance, support` (CHECK in 0053 and 0055) | no `sales`/`orders` or `marketing` role; no per-staff customisation |
| Policy | `grant: { kind: "brand", roles }` per resource (`store_product`, `store_inventory`, `store_order`, `store_return`, `store_payout`, `store_settings`, `store_staff`) | permissions are implied by role; promotions, ads, drops, branding, analytics have no own resource |
| Invites | **two tables**: `seller_staff_invites` (0053, used by `SellerMembershipService.inviteStaff`) and `seller_team_invites` (0055, used by seller-settings routes); both phone-only, 72 h, single use | consolidate into one; add email channel; add permission set to the invite |
| Seats | none (ADR-0056 defines `team.max_seats`, not enforced) | enforcement point at invite and accept |
| Seller notification prefs | per **store** x event x channel (`seller_notification_prefs`) | per **member** prefs, mutes, quiet hours, digest; seller push tokens |
| Product status | `DRAFT, ACTIVE, PAUSED, DELISTED`, system `auto_paused_price_parity`; SKU `PAUSED` | `SCHEDULED` (coming soon), derived availability, manual sold out, restock flows |
| Shopper alerts | `product_alerts` (data model), wishlist alerts `price_drop, back_in_size, low_stock, date_approaching` | `launch` and `back_in_stock` kinds, waitlist batching, bag reminder |
| Revenue | seller-analytics `sales` (GMV, commission, net, AOV, repeat rate k >= 50) | definitions reconciled to the ledger, growth math, screen mapping |

---

## 1. Team, roles and permissions

### 1.1 Model choice
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) More fixed roles (add `sales`, `marketing`) | low | owner cannot tailor ("give any permission to any staff") | low | each new need = migration + deploy |
| (b) Fine-grained permission catalogue (code-owned keys); preset roles are named bundles; each membership holds an explicit permission set (preset or customised) | medium | exact least privilege, auditable diff per change | medium | linear in keys |
| (c) Attribute-based policy expressions per store (ABAC rules authored by sellers) | high | most expressive | high (authoring UI, testing every expression) | hard to reason about, hard to test negatively |

**Choice (b).** It answers the owner's request literally while keeping the policy engine data-driven and testable; presets give one-tap setup and customisation is a checkbox diff on top, never a free-form rule. (c) is rejected because seller-authored rules cannot be covered by the negative-authorization matrix.

### 1.2 Permission catalogue (version 1, code-owned; adding a key needs an enforcement point and tests)
`S` = sensitive (owner only to grant, step-up within 5 min to use and to grant; see 1.6). `P` = exposes buyer personal data (masked, active orders only, B1).

| Key | Allows | Policy resource / action (new resources in bold) |
|---|---|---|
| `products.read` | view catalogue, drafts, size charts | `store_product` read |
| `products.write` | create, edit, media, size charts, bulk CSV import | `store_product` create/update |
| `products.publish` | publish, schedule (coming soon), pause, archive | **`store_listing_status`** update |
| `stock.read` | view stock levels, low-stock list | `store_inventory` read |
| `stock.write` | set/adjust stock, quick restock, mark sold out, stock CSV | `store_inventory` create/update |
| `drops.write` | create and schedule drops | **`store_drop`** (ADR-0056 split) |
| `orders.read` | order list and detail (buyer data masked) | `store_order` read |
| `orders.fulfil` | accept, reject, pack, ship, print AWB | `store_order` update |
| `orders.buyer_contact` `P` | unmasked delivery contact for active orders where the courier has no relay | **`store_order_pii`** read |
| `returns.manage` | inspect, approve, reject with photos | `store_return` update |
| `customers.reply` | answer Q&A and reviews publicly | **`store_engagement`** update |
| `promotions.write` | store vouchers, bundles, follower deals | **`store_promotion`** create/update |
| `ads.manage` | sponsored products campaigns within an existing balance | **`store_ads`** update |
| `ads.fund` `S` | top up the prepaid ads balance (payment) | **`store_ads_billing`** create |
| `store.branding` | profile, storefront theme (ADR-0057), cover, tagline | **`store_branding`** update |
| `store.settings` | shipping, returns policy (>= statutory), vacation, channels | `store_settings` update |
| `analytics.view` | traffic, funnel, sales counts and gross sales, growth | **`store_analytics`** read (ADR-0049 item 4) |
| `analytics.export` | watermarked CSV export | **`store_analytics`** export |
| `finance.view` | commission, fees, net earnings, statements, payouts, invoices from Z-OUTLET | `store_payout` read |
| `finance.payout_account` `S` | change payout IBAN (48 h hold stays) | **`store_payout_account`** update |
| `billing.manage` `S` | seller plan, payment method (ADR-0056) | **`store_billing`** update |
| `price_integrity.respond` | view Price Trust Score, connect evidence, appeal | **`store_price_integrity`** update |
| `team.view` | see members and their permissions | `store_staff` read |
| `team.manage` `S` | invite, change permissions, remove (bounded by 1.5) | `store_staff` create/update/delete |
| `store.closure` `S` | request offboarding (ADR-0056 1.3) | **`store_closure`** create |
| `ownership.transfer` | never grantable; derived from being an owner | n/a |

Always on for every member (not grantable, not removable): own profile, own sessions and devices, own alert preferences, the in-app alert inbox for alerts they are entitled to (2.4).

### 1.3 Preset roles (bundles; names are placeholders, owner decision T-D1)
| Preset | Permissions | Replaces today |
|---|---|---|
| Owner | all keys, plus ownership rules (1.7) | `owner` |
| Manager | all except `finance.payout_account`, `billing.manage`, `store.closure`, `ads.fund`; `team.manage` limited to non-sensitive grants (1.5) | `manager` |
| Sales / Orders | `products.read, stock.read, orders.read, orders.fulfil, returns.manage, customers.reply, analytics.view` | new (owner said "sales") |
| Marketing | `products.read, products.write, drops.write, promotions.write, ads.manage, store.branding, analytics.view, customers.reply` | new |
| Catalogue and inventory | `products.read, products.write, products.publish, stock.read, stock.write, drops.write, price_integrity.respond` | `catalog` (+ stock.write, which `catalog` lacks today) |
| Warehouse | `products.read, stock.read, stock.write, orders.read, orders.fulfil, returns.manage` | `warehouse` |
| Finance | `finance.view, analytics.view, analytics.export, orders.read, finance.payout_account, ads.fund, billing.manage` (sensitive keys still need owner grant, 1.6) | `finance` |
| Support | `products.read, orders.read, returns.manage, customers.reply` | `support` |

**Backward compatibility (hard rule).** Migration maps each existing `role` to a preset whose effective decisions on today's rules are **identical** (a property test enumerates every existing rule x legacy role and asserts the same allow/deny before and after). Deltas in the table above (e.g. catalogue gaining `stock.write`) are applied only to new grants, never silently to existing members.

### 1.4 Membership representation
- `seller_memberships` gains `preset_code text`, `preset_version int`, `customised bool`, `permissions text[]` (sorted, CHECK every element in the catalogue via a lookup table `seller_permission_keys`), `version int`. `role` stays (expand-only) and is set to the nearest legacy role for readers not yet migrated; the policy reads `permissions`.
- A non-customised membership follows its preset: when the platform publishes a new preset version, members are moved only if the change **removes** permissions or adds non-sensitive ones; additions of sensitive keys never propagate automatically.
- Effective permissions = `permissions` ∩ store restrictions (ADR-0056 `store_restrictions`, e.g. `no_ads` removes `ads.*` in effect, not in storage) ∩ entitlements (e.g. `analytics.export` false on the plan). Effective set is computed in `packages/policy`, pure.
- Policy engine extension: new grant kind `{ kind: "brand_permission", permission: PermissionKey }`. The actor's brand grant carries `permissions: ReadonlySet<PermissionKey>` per store. `evaluateSellerPermissions` returns the new keys (UI hides what is denied; the server still decides).

### 1.5 Delegation rules (no privilege escalation)
1. A granter can only grant permissions they hold effectively **and** that are non-sensitive, unless the granter is an owner.
2. Only owners grant `S` keys. A manager with `team.manage` can invite, edit and remove only members whose permission set is a subset of the manager's own and contains no `S` key; a manager cannot edit another manager or any owner.
3. Nobody edits their own permissions (prevents self-escalation and self-lockout; the last owner is covered by 1.7).
4. Removing a member or reducing permissions takes effect on the next request (1.9), not at token expiry.

### 1.6 Sensitive grants: approval
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) Owner + step-up only | low | one compromised owner session grants payout control instantly | low | fine |
| (b) Second owner approves (dual control); single-owner stores use a 24 h delayed activation with notice to the owner on every device + email, cancellable | medium | blocks instant takeover; works for one-owner shops | medium | fine |
| (c) Z-OUTLET Ops approves every sensitive grant | high | strong | staff time per grant | poor |

**Default (b).** Payout IBAN already has a 48 h activation hold; the same delayed pattern keeps small shops usable while giving a window to react. Owner decision T-D4 may choose (a) or (c). Requester != approver is a DB CHECK (existing admin approval pattern). Grants of `S` keys create `seller_grant_approvals(id, store_id, membership_id, permissions_added[], requested_by, approved_by, status PENDING|APPROVED|CANCELLED|ACTIVATED|EXPIRED, activates_at)`.

### 1.7 Owners, signatory, transfer
- **Owner** is a membership with the Owner preset. **Legal signatory** is a KYC fact on the store's application/legal entity (ADR-0056 `seller_legal_entities`), 21+ by national ID (B6 default, VR-TEAM-06). They are different: an owner can be a non-signatory (e.g. a co-founder), but payout account changes and store closure additionally require that at least one owner is the KYC signatory or an Ops-verified authorised person (default; VR-TEAM-08).
- **Last-owner protection** (existing) extends: the last owner cannot be removed, demoted, have permissions edited, or leave; the store always has >= 1 active owner until `OFFBOARDED`.
- **Ownership transfer**: owner A offers to existing member B (B must have a full session with passkey/TOTP) -> B accepts within 72 h with step-up -> B becomes owner; A stays owner until A separately steps down (two steps, never an atomic swap, so a failure never leaves zero owners). If B is to become the legal signatory, a KYC change request goes to Ops (documents, 21+), and until approved B has no payout-account or closure power. All owners and the signatory are notified on every device + email at offer, accept and step-down.
- Max owners per store: 3 (config).

### 1.8 Invitations (one table, replaces the two)
Flow: granter picks preset or custom set -> enters Egyptian mobile (E.164 +20, existing) **or** email (owner decision T-D5; default phone only) -> invite created -> message with a link -> invitee signs in (OTP for that phone, or verified email + phone OTP) -> enrols passkey or TOTP (existing enrol flow) -> attests 18+ (staff age rule, VR-TEAM-06) -> accepts -> membership created.

Rules:
- Token 256-bit CSPRNG, stored SHA-256, single use, 72 h TTL (config 24 to 168 h), bound to the invited phone blind index (or email blind index): accepting with a different identity is 404, indistinguishable from unknown (existing).
- Seat check at **invite and at accept** against `team.max_seats` (ADR-0056 `EntitlementsPort`, fail closed to the fallback plan). Default counting: active non-owner memberships + pending invites; owners are not counted, one owner seat always exists (T-D3).
- Pending invite per (store, contact) unique; resending rotates the token and expires the old one; max 20 pending invites per store, 10 invites per hour per granter.
- The invite stores the permission set; acceptance re-validates it against the granter's **current** rights (if the granter lost them, the invite fails `invite_granter_lacks_rights`).
- `S` keys in an invite go through 1.6 after acceptance (membership starts without them).
- A suspended or offboarding store cannot invite. A seller user who is suspended platform-wide cannot accept.
- Migration: `seller_team_invites` (0055) becomes the single table with new columns (`contact_kind phone|email`, `email_blind`, `preset_code`, `permissions text[]`); open rows of `seller_staff_invites` (0053) are copied, then the old write path is removed (expand/contract over two releases).

### 1.9 Sessions and devices
- Existing: FULL session only with passkey or TOTP; access JWT 10 min; rotating refresh 30 days with reuse detection; step-up within 5 min for sensitive actions.
- New: permissions are **not** in the JWT. The guard reads the member's effective set from a per-(seller_user, store) projection cached <= 5 s and invalidated by the outbox event `seller.membership_changed`. Removing a member also revokes their sessions **for that store's scope**; if they have no other store, all their seller sessions are revoked.
- Owner sees each member's active sessions (device label, platform, last seen, approximate city from IP at the time, never raw IP) and can revoke them. `team.manage` holders see sessions only of members they may manage.
- Idle timeout for Seller Center web 30 min (config), absolute session 30 days (existing refresh).
- Optional per-store policy "passkey only" (disallow TOTP) for owners who want it.
- New device sign-in for a member with any `S` key notifies all owners.

### 1.10 Audit
Every team action writes the hash-chained `audit_log` (A2.9) **and** `seller_settings_events` (area `team`): actor, action (`invite.created|resent|revoked|accepted|declined`, `member.permissions_changed`, `member.removed`, `grant.approval_*`, `ownership.offer|accept|step_down`, `session.revoked_by_owner`), target membership, before/after permission diff (keys only), request id, device id. Owners and `team.view` holders read an "Activity" view of their store's team events (no IP). Retention follows B1 (audit log period, VR-TEAM-07).

### 1.11 Enforcement layers
1. **Guard**: `@Authorize(resource, action)` -> policy `decide()` with the actor's effective permissions; foreign store = 404 (body identical to missing), own store without permission = 403 `permission_denied` with the missing key name (keys are not secret).
2. **Postgres RLS** stays the tenant boundary: `app_store_ids()` for store-scoped tables; new tables get RLS in the same migration. RLS does not encode permission keys (granularity lives in the guard; RLS proves cross-tenant isolation even if a guard is missing).
3. **Domain**: use cases that hand out buyer contact (`orders.buyer_contact`) check again and write a reason-coded PII-view audit row.

### 1.12 Data (new or changed)
| Table | Key columns | PII |
|---|---|---|
| `seller_permission_keys` (seeded, code-owned) | `key PK, sensitive bool, exposes_pii bool, introduced_in` | P0 |
| `seller_role_presets` (seeded, versioned) | `code, version, name_ar, name_en, permissions text[], effective_from`; PK `(code, version)` | P0 |
| `seller_memberships` (+cols) | `preset_code, preset_version, customised, permissions text[], version` | P1 |
| `seller_team_invites` (+cols, single table) | `contact_kind, phone_blind, phone_enc, email_blind, email_enc, contact_masked, preset_code, permissions text[], token_hash, status, expires_at` | P3 contact enc |
| `seller_grant_approvals` | 1.6 | P1 |
| `seller_ownership_transfers` | `id, store_id, from_user, to_user, status OFFERED|ACCEPTED|DECLINED|EXPIRED|CANCELLED, expires_at, signatory_change bool, kyc_request_id` | P1 |
| `seller_store_security_policy` | `store_id PK, passkey_only bool, idle_timeout_min` | P1 |

Indexes: `seller_memberships (store_id) WHERE revoked_at IS NULL` (exists); GIN on `permissions` only if the "who can receive alert X" query (2.4) needs it at scale. `data_inventory.yaml` tags for every new column (CI gate).

### 1.13 API sketch (audience `seller_api`, store-scoped, Problem+JSON, writes need `Idempotency-Key`)
| Route | Permission | Idem | Limit |
|---|---|---|---|
| `GET /v1/seller/permissions/catalogue` (keys, AR/EN labels, sensitive flag, presets) | any member | n/a | 60/min |
| `GET /v1/seller/stores/{storeId}/team/members` | `team.view` | n/a | 60/min |
| `PATCH /v1/seller/stores/{storeId}/team/members/{membershipId}` `{preset_code}` or `{permissions[]}` + `If-Match` | `team.manage` (+ 1.5, 1.6) | yes | 20/min |
| `DELETE /v1/seller/stores/{storeId}/team/members/{membershipId}` | `team.manage` (+ 1.5), step-up | yes | 20/min |
| `POST /v1/seller/stores/{storeId}/team/invites` `{contact, preset_code | permissions[]}` | `team.manage` | yes | 10/h per granter |
| `POST .../team/invites/{id}/resend`, `DELETE .../team/invites/{id}` | `team.manage` | yes | 10/min |
| `POST /v1/seller/team-invites/accept|decline` (existing self routes) | invitee | yes | 10/min |
| `GET/POST .../team/grant-approvals`, `POST .../{id}/approve|cancel` | owner, step-up | yes | 20/min |
| `POST .../team/ownership-transfers`, `POST .../{id}/accept|decline|cancel`, `POST .../team/owners/me/step-down` | owner / target member, step-up | yes | 5/h |
| `GET .../team/members/{id}/sessions`, `DELETE .../sessions/{sessionId}` | owner (or 1.5 scope) | yes | 20/min |
| `GET .../team/activity?cursor=` | `team.view` | n/a | 60/min |
| `GET /v1/seller/me/permissions?storeId=` (effective keys, existing permissions endpoint extended) | any member | n/a | 120/min |

Errors: 403 `permission_denied` (`missing: key`), 403 `step_up_required`, 409 `last_owner`, 409 `seat_limit_reached` (`limit`, `used`), 409 `version_conflict`, 409 `invite_expired`, 422 `cannot_grant_unheld_permission`, 422 `sensitive_requires_owner`, 422 `self_edit_forbidden`.

### 1.14 Events
Outbox (same tx): `seller.membership_granted` (exists), `seller.membership_changed {store_id, membership_id, added[], removed[]}`, `seller.membership_revoked` (exists), `seller.invite_created|accepted|expired`, `seller.sensitive_grant_requested|activated|cancelled`, `seller.ownership_transfer_offered|accepted|stepped_down`. Payloads: ids and keys only, no contact data. Analytics: `seller_team_invite_sent(preset, customised)`, `seller_permissions_customised(n_added, n_removed)`.

### 1.15 Negative authorization tests (each becomes a matrix row; BOLA = API1, BFLA = API5)
1. Seller A member -> any store B team route (list, patch, delete, invite, approvals, transfers, sessions, activity): 404, body byte-identical to an unknown store id.
2. Member of A -> membership id belonging to B via A's path (`/stores/A/team/members/{B-member}`): 404.
3. Member without `team.view` -> list members: 403 `permission_denied`.
4. Manager with `team.manage` -> grant `finance.payout_account` (sensitive): 422 `sensitive_requires_owner`.
5. Manager -> edit another manager, an owner, or a member holding a key the manager lacks: 403.
6. Any member -> PATCH own membership: 422 `self_edit_forbidden`.
7. Granter -> grant a key they do not hold: 422 `cannot_grant_unheld_permission`.
8. Last owner -> remove self, step down, be edited: 409 `last_owner`.
9. Invite accepted by a different phone/email identity: 404; replay of a used token: 404; expired: 409.
10. Invite created by a manager who loses `team.manage` before acceptance: accept fails `invite_granter_lacks_rights`.
11. Removed member's still-valid access token (< 10 min old) -> any store route after the outbox invalidation: 403/404 within 5 s (time-boxed test with the projection).
12. Sales preset -> `PUT /v1/seller/skus/{id}/stock`: 403; Warehouse preset -> `GET .../analytics/sales`: 403; Marketing -> payouts: 403; Support -> unmasked buyer contact: 403.
13. `orders.buyer_contact` holder -> contact of an order closed > 30 days ago: 404 (B1 access end).
14. Seat limit reached -> invite: 409; downgrade below used seats -> existing members unaffected, new invites 409 (ADR-0056 freeze policy).
15. Shopper-audience token and admin-audience token on every seller team route: 401.
16. Store with restriction `no_ads` -> member holding `ads.manage` -> ads write: 403 `store_restricted`.
17. Sensitive grant approval: requester approves own request: 409 (DB CHECK).
18. Ownership transfer to a non-member or a member without a strong factor: 422.
19. Owner of A revoking a session id that belongs to a member of B: 404.
20. RLS: direct SQL as `app_user` with `app.store_ids = A` cannot read `seller_grant_approvals`, `seller_ownership_transfers`, invites of B (PGlite contract test).

---

## 2. Product availability

### 2.1 Two axes, not one enum
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) One status enum mixing lifecycle and stock (`ACTIVE, SOLD_OUT, LOW_STOCK, COMING_SOON, ...`) | low | wrong: stock changes every second and is per SKU; a stored "sold out" goes stale | low | write storm on every reserve |
| (b) Stored **listing status** (seller intent) + **derived availability** per SKU and per product from inventory counters | medium | exact, never stale: computed from the same counters as checkout | medium | fine (outbox-fed projection for search) |

**Choice (b).** Availability is a function of `on_hand - committed - reserved` (inventory spec) so it can never disagree with checkout; the seller controls only intent.

### 2.2 Listing status machine (product level; SKUs keep `ACTIVE | PAUSED`)
Existing values kept; `SCHEDULED` added; `DELISTED` is the archive state (UI label "Archived").

| From | Event | To | Guard | Who |
|---|---|---|---|---|
| DRAFT | publish | ACTIVE | publish gate (catalog 2.4: Arabic title, images, priced SKU, size chart if apparel, legal identity) | `products.publish` |
| DRAFT | schedule(launch_at?) | SCHEDULED | publish gate; `launch_at` null or now+1 h .. now+90 d | `products.publish` |
| SCHEDULED | launch_at reached (job, 1 min tick) | ACTIVE | publish gate re-run; store not restricted; if gate fails -> stays SCHEDULED, alert `launch_blocked` | system |
| SCHEDULED | launch_now | ACTIVE | gate | `products.publish` |
| SCHEDULED | reschedule(launch_at) | SCHEDULED | see 2.5 honesty rules | `products.publish` |
| SCHEDULED | unschedule | DRAFT | waitlist kept 30 d | `products.publish` |
| ACTIVE | pause | PAUSED | none | `products.publish` |
| PAUSED | resume | ACTIVE | gate | `products.publish` |
| ACTIVE, PAUSED | parity violation (spec 9.5) | `auto_paused_price_parity` | system only | system |
| `auto_paused_price_parity` | parity fixed (re-scored) | ACTIVE | system only | system |
| DRAFT, SCHEDULED, ACTIVE, PAUSED | archive | DELISTED | open orders unaffected | `products.publish` |
| DELISTED | restore | DRAFT | none | `products.publish` |
| any | store `OFFBOARDING` / restriction `no_new_listings` (new publishes only) | unchanged, publish/launch refused | ADR-0056 | system |

Invalid transitions throw the shared typed error; every edge unit-tested; property test: no reachable state outside the table; ACTIVE is unreachable without the gate.

**Note: drops** keep their own machine (`DRAFT -> SCHEDULED -> EARLY_ACCESS -> LIVE ...`, spec 16). A product inside a scheduled drop is shown through the drop, not through `SCHEDULED`; a product cannot be both (guard).

### 2.3 Derived availability (per SKU, rolled up per product)
`free = max(0, on_hand - committed - reserved)` on the STANDARD pool at the SKU's location (inventory spec 2).
| SKU availability | Condition | Shopper display (spec 5, A2.13) |
|---|---|---|
| `IN_STOCK` | free > low threshold | no count |
| `LOW_STOCK` | 1 <= free <= 5 | "Only {n} left in {size}" (real count, existing `displayableStock`) |
| `SOLD_OUT` | free = 0, SKU ACTIVE | "Sold out" + "Notify me" |
| `UNAVAILABLE` | SKU PAUSED or product PAUSED | "Currently unavailable" (never "sold out": it is a seller choice, not scarcity) |
| `COMING_SOON` | product SCHEDULED | "Coming soon" (+ date per 2.5) + "Notify me" |

Product roll-up: `IN_STOCK` if any SKU in stock; `SOLD_OUT` only if every ACTIVE SKU is sold out. "Reserved" units can return (reservation expiry), so `SOLD_OUT` can revert to `LOW_STOCK` within minutes; that is true, not a trick, and does not fire back-in-stock (2.7).

Seller low-stock **alert** threshold (section 3) is separate from the shopper display rule and configurable per store and per SKU (default 5, owner decision T-D10); it never changes what shoppers see.

### 2.4 Manual "mark sold out"
| Option | Accuracy | Notes |
|---|---|---|
| (a) A display-only "sold out" flag while stock exists | false scarcity (shows sold out when units exist) | rejected, A2.13 / CPL |
| (b) "Mark sold out" = stock adjustment that sets free stock to 0 (`set on_hand = committed + reserved`, reason `marked_sold_out`) | true: nothing is offered | chosen |
| (c) Pause the SKU | true; displays "Currently unavailable" | offered alongside (b) |

(b) uses the existing `PUT /v1/seller/skus/{skuId}/stock` path (idempotent, `If-Match`, writes `inventory_adjustments`), so the row-per-unit pool trims itself and no oversell can follow. Open orders and active reservations are honoured. If a channel integration is connected for the SKU, the UI warns that the next sync will overwrite it and offers "pause sync for this SKU" (`channel_sync_holds(sku_id, until)`), otherwise channel truth wins (inventory spec: `source_version` monotonic).

### 2.5 Coming soon (honesty rules)
- `launch_at` optional. Without it the PDP says "Coming soon" with no date.
- A **countdown** is shown only when all hold: `launch_at` set, within 7 days, launch is automatic (2.2 job), the countdown is server-time synced (CountdownRing, spec 25), and the listing has not been postponed more than once. A second postponement removes the countdown permanently for that listing (owner decision T-D9 may forbid countdowns entirely). Moving `launch_at` **earlier** than shown is allowed only with >= 24 h notice to the waitlist.
- Price must be set at scheduling; the price block follows spec 9 (no history => "Launch price" label after launch, never "% off").
- Not addable to bag, not reservable, not in stylist outfits or budget "affordable now" (they need purchasable items), not in Buy Box. Appears in search only under the "Coming soon" facet and on the store page section "Coming soon"; excluded from default "in stock" ranking.
- Stock may be loaded before launch; it is invisible to shoppers until ACTIVE.
- **Restock-expected label** (SKU sold out): optional seller date, shown as "The store expects a restock around {date}" (seller estimate, labelled as such); auto-removed 7 days after the date; max one change per 14 days (owner decision T-D8; default off).

### 2.6 Restock flows
- **Quick restock (mobile brand mode + Seller Center web):** "Needs restock" list = SKUs `SOLD_OUT` or `LOW_STOCK` (by the seller threshold), sorted by waitlist size then 7-day sales velocity. Each row: size/colour, free, waitlist count (a count only, never identities), +/- stepper, "Received N" -> `PUT .../stock {mode:"adjust", quantity:+N, reason:"received"}` with `Idempotency-Key` per tap and `If-Match`. Offline: queued with its key, replayed on reconnect; a 409 shows the fresh level for re-confirmation (no blind overwrite).
- **Bulk CSV:** `POST /v1/seller/stores/{storeId}/stock-imports` (multipart, <= 5,000 rows, columns `sku_code, mode(set|adjust), quantity, reason`) -> dry run report (unknown SKU, negative result, duplicate rows, rows below committed flagged as oversell risk) -> `POST .../stock-imports/{id}/apply` (idempotent by import id; each row uses key `import:{importId}:{row}`), applied in batches of 200 in SKU order (lock ordering, inventory spec), partial failures reported per row; `GET .../stock-imports/{id}`. Permission `stock.write`. Formula-guarded error report CSV.
- **Channel sync** (existing) remains the third path.

### 2.7 Back in stock and waitlists
- Trigger `sku.back_in_stock` fires only when free goes from 0 to > 0 **because of an `on_hand` increase** (adjustment reasons `received`, `recount`, `channel_sync`, `RETURN_RESTOCK`), not because a reservation expired or was released (that would flap). Debounce: at most once per SKU per 24 h.
- `product_alerts` gains kinds `back_in_stock` and `launch` (existing unique `(user_id, product_id, sku_id, kind)`). Notify-me is created by the shopper's explicit tap (`POST /v1/products/{id}/alerts`, existing), requires an account (guests: device-only reminder disabled; prompt to sign in, ADR-0055).
- **Batching (honest):** notify the waitlist FIFO in batches of `min(waitlist, 3 x free)` (factor config), re-checking free stock before each batch; next batch 30 min later only if still in stock. Message wording "Back in stock in {size}", never "reserved for you" (nothing is reserved until checkout, inventory spec), and a stock count only if it is real and <= 5 at render time.
- Consent: see 5.2 (classification is VR-TEAM-01). In-app inbox always; external channel per `decideChannel`.

### 2.8 Search index and PDP
- Outbox `product.availability_changed {product_id, sku_ids[], availability, listing_status, version}` emitted by an inventory consumer when the derived roll-up **bucket** changes (not on every unit), plus `product.status_changed` (exists). Search-sync updates facets `availability` and `listing_status`; staleness SLO < 60 s (spec 4). PDP and bag re-read from Postgres (existing rule), so stale index never sells a sold-out unit.
- PDP behaviour per 2.3; "Notify me" for SOLD_OUT and COMING_SOON; nearest-size suggestion when the chosen size is sold out (spec 5).

### 2.9 Data, API, events (availability)
Data: `products.status` CHECK adds `SCHEDULED`; `products.launch_at timestamptz NULL`, `products.launch_postponements smallint`, `skus.restock_expected_on date NULL`, `skus.restock_label_changed_at`, `store_stock_alert_settings(store_id PK, default_low_threshold)`, `sku_stock_alert_thresholds(sku_id PK, threshold)`, `channel_sync_holds`, `stock_imports(id, store_id, status, rows, created_by, ...)`, `stock_import_rows`. Inventory tables unchanged (ADR-0005).
API: `POST /v1/seller/products/{id}/schedule {launch_at?}`, `/launch-now`, `/unschedule`, `/pause`, `/resume`, `/archive`, `/restore` (all `products.publish`, idempotent, `If-Match`); `POST /v1/seller/skus/{id}/mark-sold-out` (`stock.write`, thin wrapper over the stock route); `PUT /v1/seller/skus/{id}/restock-label`; `GET /v1/seller/stores/{id}/restock-list?cursor=`; stock imports above; `PUT .../stock-alert-settings`.
Events: `product.scheduled|launched|launch_blocked|rescheduled`, `product.availability_changed`, `sku.sold_out`, `sku.low_stock` (seller threshold crossing downward, debounced 1 h per SKU), `sku.back_in_stock`, `stock_import.completed`.

---

## 3. Seller alerts

### 3.1 Catalogue (defaults are owner decision T-D10; "critical" cannot be fully muted, see 3.3)
| Type | Trigger | Recipients (effective permission) | Class | Default channels |
|---|---|---|---|---|
| `stock_out` | `sku.sold_out` | `stock.read` | operational | push + inbox, coalesced |
| `low_stock` | `sku.low_stock` | `stock.read` | operational | inbox + daily digest |
| `new_order` | `seller_order.paid` / `confirmed_cod` | `orders.fulfil` | operational | push + inbox (coalesced per 5 min) |
| `accept_sla_warning` | order unaccepted at 18 h of the 24 h window (spec 19) | `orders.fulfil` | **critical** | push + inbox (+ email) |
| `dispatch_sla_warning` | 75% of dispatch SLA elapsed | `orders.fulfil` | **critical** | push + inbox |
| `order_auto_cancelled` | SLA auto-cancel | `orders.fulfil`, owners | critical | push + inbox + email |
| `return_requested` / `return_received` / `inspection_due` (48 h, silence = auto-approve) | returns events | `returns.manage` | operational / critical for `inspection_due` | push + inbox |
| `payout_sent` / `payout_failed` / `payout_held` | payouts events | `finance.view` | operational / critical for failed | inbox + email |
| `price_integrity_warning` | parity demotion with 48 h to fix, claim auto-corrected, badge removed | `price_integrity.respond`, owners | **critical** (auto-pause follows) | push + inbox + email |
| `launch_blocked` | 2.2 | `products.publish` | operational | push + inbox |
| `team_security` | new member, permission change, sensitive grant pending, ownership offer, new device for an `S` holder | owners (+ the affected member) | **security** (never mutable, ignores quiet hours) | push + inbox + email |
| `billing` | ADR-0056 payment failed, past due | `billing.manage` | critical | inbox + email |
| `restriction` | `store_restriction.added|lifted` | owners | critical | inbox + email |

Payloads carry ids, counts and product titles only: **no buyer personal data**, no amounts in push text for finance alerts (shown after opening, behind auth), Arabic-first templates (N13).

### 3.2 Preferences, mutes, quiet hours, digest
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) Keep per-store prefs (today) | low | one staff member's choice silences everyone | low | fine |
| (b) Per-member prefs with store defaults set by owners; member overrides within allowed bounds | medium | each person controls their phone; owners guarantee coverage of critical alerts | medium | fine |

**Choice (b).** `seller_notification_prefs` becomes the store **default** layer; new `seller_member_alert_prefs(membership_id, alert_type, channel, enabled)` overrides.
- **Mute / snooze:** `seller_alert_mutes(id, membership_id, scope all|type|product|sku, ref_id, until)`; quick durations 1 h, 4 h, 8 h, until tomorrow 09:00 Cairo, 7 days, custom (max 30 d). Muted alerts still land in the inbox (unread badge), never lost.
- **Quiet hours** per member, default 23:00 to 09:00 Africa/Cairo (same rule as N5/N6, Egyptian DST computed explicitly), editable; operational alerts deferred to the end of quiet hours, then coalesced.
- **Critical** alerts ignore snooze and quiet hours **unless** the member chose "Do not disturb, I have a backup": allowed only if at least one other active member with the same permission has push enabled and is not muted at that moment; otherwise the critical alert still goes through (prevents a store missing the 24 h SLA because everyone muted). **Security** alerts are never muted.
- **Digest:** per member, off | daily at chosen hour (default 09:00 Cairo) | hourly; includes low stock, returns summary, operational alerts deferred or muted. One push "Your daily summary" deep-linking to the inbox.
- **Store coverage check:** if a critical type has zero reachable recipients (no push token, all disabled), owners see a banner "Nobody will receive SLA warnings" and receive email.

### 3.3 Delivery rules
1. Resolve recipients = active members whose effective permissions match (1.4), store not offboarded.
2. Per member: security -> send; critical -> send unless 3.2 backup rule; operational -> check mute, quiet hours, prefs, then rate limit.
3. **Coalescing:** same type + store within a window (stock_out 5 min, new_order 5 min) becomes one message ("7 items sold out", "3 new orders") with a list in the inbox.
4. **Rate limit:** max 10 pushes per member per hour (config); overflow goes to the next digest and the inbox.
5. Channel order per member preference: push (Expo) -> email -> WhatsApp (utility template, only if approved and configured, VR-TEAM-03/VR-COMMS-03) -> SMS (critical and security only, cost-capped per store per day). Seller alerts are B2B operational messages to staff: not marketing, no marketing consent purpose applies (VR-TEAM-07 confirms the staff-data basis).
6. Idempotency `(membership_id, alert_type, ref)`; replays are no-ops (A2.7).

### 3.4 Push for sellers
- New `seller_push_tokens(id, seller_user_id, install_id, platform, token_enc, token_hash, created_at, last_seen, deactivated_at)`, unique active on `token_hash`; separate from shopper `notification_push_tokens` because seller identity is separate (ADR-0031 d1). The same physical device may hold one shopper token row and one seller token row (the mobile role choice); the app routes the notification by a `persona` field in the data payload and shows a persona badge.
- Registered after a FULL seller session; deactivated on seller logout, session revoke, membership removal from the last store, or `DeviceNotRegistered` (N9).
- iOS: permission prompt shown from the brand-mode alert settings screen after explaining value, never at launch (B7, spec 1 rule "after a value screen"). Payload text avoids personal data because it shows on the lock screen; Expo relays it (residency: VR-TEAM-11 extends VR-COMMS-01, VR-02).

### 3.5 Failure handling
Existing N7: provider failover, exponential backoff with deterministic jitter, TTL 24 h for operational, 2 h for SLA warnings (stale after the SLA), 15 min for security codes. Push failure -> next channel for critical; inbox always written. DLQ + replay for the alert consumer; consumer idempotent via `inbox_processed`. Metric `seller_alert_unreachable_total{type}`.

### 3.6 Data, API, events (alerts)
Data: `seller_member_alert_prefs`, `seller_alert_mutes`, `seller_member_quiet_hours(membership_id PK, start, end, digest_mode, digest_hour)`, `seller_push_tokens`, `seller_alert_inbox(id, store_id, membership_id, type, ref, title_key, payload jsonb (ids/counts), created_at, read_at, expires_at)` (90 d, N17), `seller_alert_deliveries` (log, partitioned monthly).
API: `GET/PATCH /v1/seller/me/alert-preferences?storeId=`, `POST/DELETE /v1/seller/me/alert-mutes`, `PUT /v1/seller/me/quiet-hours`, `PUT /v1/seller/me/devices/push-token`, `GET /v1/seller/me/alerts?storeId=&cursor=`, `POST /v1/seller/me/alerts/read`, `GET/PUT /v1/seller/stores/{storeId}/alert-defaults` (owner).
Events: `seller_alert.sent|suppressed|deferred|coalesced|unreachable`. Analytics: `seller_alert_opened(type)`, `seller_alert_muted(scope, duration)`.

---

## 4. Revenue and growth tracking

### 4.1 Definitions (all integer piastres, VAT-inclusive unless stated, Africa/Cairo day buckets per ADR-0047)
| Metric | Definition | Date basis | Source | Permission |
|---|---|---|---|---|
| Orders | seller orders `PAID` or `CONFIRMED_COD` | placed_at | seller-analytics facts | `analytics.view` |
| Gross sales (placed) | sum of line `unit_price x qty - seller-funded item discounts` (shopper-paid merchandise value attributable to the store; platform-funded discounts do **not** reduce it) for those orders | placed_at | facts | `analytics.view` |
| Cancelled | gross of orders cancelled before shipment (incl. seller rejection, SLA auto-cancel) | cancelled_at | facts | `analytics.view` |
| Delivered sales | gross of lines delivered (`delivered_at`) | delivered_at | facts | `analytics.view` |
| Returns and refunds | refunded merchandise value (cumulative refunded value per line, refunds R4) | refund completed_at | ledger + facts | `analytics.view` |
| Net sales | delivered sales - returns and refunds | per component | derived | `analytics.view` |
| Commission (+ VAT on commission) | snapshot rate x net base per ledger R3 | recognition date | **ledger** | `finance.view` |
| Fees | shipping charged to the seller, FBH fees, ads spend, seller subscription (ADR-0056), RTO costs per D6 | posting date | ledger | `finance.view` |
| Net earnings | credits to `seller_payable:{store}` minus reversals in the period (= what the statement shows) | posting date | **ledger** | `finance.view` |
| Pending vs paid out | `seller_payable` balance not yet eligible (before `CLOSED` + buffer) / eligible / paid | as of now | ledger + payouts | `finance.view` |
| AOV | gross sales (placed) / orders, banker's rounding (existing) | placed_at | facts | `analytics.view` |
| Units, sell-through, return rate | existing seller-analytics definitions | | facts | `analytics.view` |
| Repeat-customer rate | buyers in window with >= 2 orders from this store (lifetime up to window end) / buyers in window; **withheld below 50 distinct buyers** (existing `K_ANONYMITY_MIN`) | placed_at | facts | `analytics.view` |
| Demographic / geography cells | governorate (and any future attribute) cells **only with k >= 50 distinct shoppers**, additive suppression (existing `kAnonymizeAdditive`); no age, gender or budget data ever (spec 12) | | facts | `analytics.view` |

**Reconciliation rule:** "Net earnings" is ledger truth and must equal the statement; analytics "net sales" is a commercial metric and is labelled differently so sellers never compare two "net" numbers that disagree. A nightly check asserts that for each store and closed day, facts-derived commission equals ledger commission (break -> analytics ticket, not finance).

### 4.2 Growth
- Period-over-period growth `g = (cur - prev) / prev`, computed in integer basis points with half-even rounding at one point; **null when prev = 0** (UI shows "New" and the absolute value), never infinity or a fake 100%.
- Comparable windows: same length, previous adjacent period; weekly windows start Saturday (ADR-0047 default); "same period last year" only when >= 13 months of history; partial current periods compare to the same elapsed span of the previous one ("month to date vs same days last month"), labelled.
- Every growth figure shows the absolute delta next to the percentage. Event annotations (Ramadan, Eid, White Friday, store vacation, restriction days) on the chart.
- Differencing defence: windows snapped to whole Cairo days (existing), rate limits, export audit.

### 4.3 Screens
| Screen | Shows | Permission |
|---|---|---|
| Mobile brand mode home | today and 7 d: orders, gross sales, growth vs previous 7 d, items to restock, unaccepted orders | `analytics.view` (money tiles hidden without it), alerts for all |
| Seller Center `/dashboard` | same + 30/90 d chart, top products, sell-through | `analytics.view` |
| `/insights` (existing) | funnel, traffic, repeat rate (k-gated), geography (k-gated), growth by period | `analytics.view` |
| `/finance` (existing) | commission, fees, net earnings, pending/eligible/paid, statements, invoices from Z-OUTLET | `finance.view` |
| Export | watermarked CSV (existing pipeline) | `analytics.export` |

### 4.4 API
Extend existing `GET /v1/seller/stores/{storeId}/analytics/sales?from=&to=&compare=previous|last_year&granularity=day|week|month` with `growth` objects `{cur, prev, delta, growth_bps | null}`; new `GET .../finance/summary?from=&to=` (ledger-backed, `finance.view`). Every response carries `meta.freshness` (<= 15 min SLO, spec 19.1).

---

## 5. Shopper reminders: bag and back in stock

### 5.1 Principles
- The **platform** sends reminders, never the seller. Sellers never receive the identity, contact or bag of any shopper who did not buy (no "abandoned cart list"); at most an aggregate count with k >= 50 (owner decision T-D7, default not shown).
- Reminders state only true facts at send time; stock and price are re-read when the message is rendered **and** again at release if deferred (N16 renders at request time, so deferred bag reminders are rendered at release; implementation note for the builder).
- Budget data is never used to target or word a reminder (spec 12 lint rule).
- Guests (ADR-0055) get no reminders: their bag is device-only and no consent exists.

### 5.2 Classification and consent
| Option | Risk |
|---|---|
| (a) Treat the bag reminder as transactional (no marketing consent) | if counsel or the regulator considers it promotional, every send without consent is a PDPL breach; Apple 4.5.4 likely treats it as promotional |
| (b) Treat it as **marketing**: needs `marketing_push` / `marketing_whatsapp` / `marketing_email` consent, quiet hours, caps, one-tap unsubscribe | fewer recipients |

**Default (b)** (safest; reversible later by data if counsel says otherwise; VR-TEAM-01). Back-in-stock and launch alerts are explicitly requested by the shopper per item; they stay in the existing switchable marketing type `BACK_IN_SIZE` (N15) for now, with the same VERIFY row asking whether an explicit per-item request can be sent as a service message. A new switchable type `BAG_REMINDERS` is added to N15. Using bag contents for a reminder is a purpose question (VR-TEAM-02). Default: the channel marketing consent is the gate, with a RoPA entry "bag reminders" under the marketing purpose; `personalization` consent is not used as a second gate because it covers ranking, not messaging. Counsel may require otherwise (VR-TEAM-02).

### 5.3 Trigger and stop conditions
A bag becomes a reminder candidate when all hold: signed-in shopper; >= 1 `IN_BAG` line that is `available` in an `open` store; no order group placed and no checkout started since the last bag change; last bag write >= `first_delay` ago. Signals are server-side only (bag writes, checkout attempts, orders), never app-analytics events (those need `analytics` consent).
Stop (cancel pending steps) on: order placed containing any bag line, bag emptied, all lines unavailable, shopper opened the bag after the trigger (`GET /v1/cart`), consent withdrawn, `BAG_REMINDERS` off, store opt-out, account deletion requested, shopper blocked or in a budget hard-cap lock (spec 12: never nudge spending while the shopper's own cap is active; uses only the boolean lock state from the budget module through a port that returns `locked: boolean`, no amounts).

### 5.4 Timing ladder
**Default (master prompt section 24 "bag reminder once"):** exactly **one** reminder per bag episode, at `first_delay` = 3 h after the last bag change (config 1 to 24 h), deferred out of quiet hours 23:00 to 09:00 Cairo (N5), counted in the shared marketing caps 1 per Cairo day / 3 per rolling 7 days (N4), expires after 48 h (dropped, never sent late). A new episode needs a new bag change and at least 7 days since the last bag reminder.

**Optional multi-step ladder (owner decision T-D6, SHEIN-style):** up to 3 steps, e.g. 1 h / 24 h / 72 h, enabled only by an owner decision recorded in the ADR and a dual-approved change of `reminder_policy` (admin, audited). Even when enabled: caps N4 and quiet hours N5 still apply and are never overridden; each step is content-distinct (step 2 may mention a true price drop; step 3 may mention true low stock); any stop condition cancels all remaining steps; step 3 is skipped if the shopper ignored steps 1 and 2 on two consecutive episodes (fatigue rule); one ladder per 7 days. Overriding "once" contradicts master prompt section 24 and must be recorded as a deviation in ADR-0058.

### 5.5 Content rules (CPL 181/2018, A2.13, spec 18)
- Allowed true facts: item names (up to 3, "+N more"), store names, "price dropped since you added" only when current price < `price_at_add` (shown as the two prices, never as "% off" unless the spec 9 VRP verifies a claim), "only {n} left" only when the real free count is <= 5 at render, free-delivery progress ("add X EGP from {store} for free delivery") computed by the cart quote, Plus saving only if true for this bag.
- Forbidden: invented deadlines or timers, "items reserved for you" (nothing is reserved), "others are looking at your item" unless spec 16 thresholds are met with real data, vouchers created only for abandoners unless a promotion exists under spec 17 with its own targeting (owner decision; no "abandon to get a discount" loop by default), confirm-shaming copy.
- Arabic-first templates with English pair (N13), CI copy lint for numeric social proof (A2.13).
- Deep link: `/bag?src=reminder&rid={requestId}` (N18 app route); opening it counts as "opened bag" (stop condition) and attributes conversions.

### 5.6 Opt-outs and unsubscribe
- Push: each reminder has an action "Stop bag reminders" (sets `BAG_REMINDERS.push=false`); Settings -> Notifications toggle; withdrawing `marketing_push` stops all marketing push (N11).
- Email: `List-Unsubscribe` + one-click (`List-Unsubscribe-Post`) header and a footer link; WhatsApp: quick-reply "Stop" mapped to `UNSUBSCRIBED` suppression on that channel (VR-TEAM-03 for template category and opt-in proof).
- **Per-store:** shopper "Don't remind me about items from {store}" (`shopper_store_reminder_optouts(user_id, store_id)`); store-level `allow_bag_reminders` (default true; owner decision T-D7 whether sellers may opt out).

### 5.7 Measurement (A/B with holdout)
- Assignment by hash of `(user_id, experiment_id)`; default holdout 10% gets no reminder (owner decision T-D11). Primary metric: bag-to-order conversion within 7 days of episode start, incremental vs holdout. Guardrails: unsubscribe rate per send, complaint rate, return rate of reminder-attributed orders, app uninstall proxy (push token loss). Stop rule: unsubscribe rate > 2x baseline marketing average or complaints > threshold -> kill switch `kill.bag_reminders` (A2.12).
- Analytics events (consent-aware, no PII): `bag_reminder_sent(step)`, `bag_reminder_opened(step)`, `bag_reminder_converted(step)`; server outbox `bag_reminder.scheduled|suppressed{reason}|sent|cancelled{reason}`.

### 5.8 Apple notes (VERIFY at submission, VR-TEAM-04)
App Store Review Guideline 4.5.4 (as last read; verify current text): push must not be required for the app to work, and must not be used for promotions or direct marketing unless the customer explicitly opted in through consent language shown in the app's UI, with a way to opt out in the app. The marketing-consent default of 5.2 plus in-app opt-out (5.6) is designed to satisfy that; the seller push prompt is for operational alerts only.

### 5.9 Data, API, events (reminders)
Data: `bag_reminder_episodes(id, user_id, cart_version, started_at, status OPEN|CONVERTED|STOPPED|EXPIRED, stop_reason, experiment_id, holdout bool)`, `bag_reminder_steps(episode_id, step, scheduled_for, notification_request_id, status)`, `shopper_store_reminder_optouts`, `stores.allow_bag_reminders`, `reminder_policy(version, steps jsonb, first_delay_min, max_steps, approved_by, approval_id, effective_from)`, `product_alerts.kind` + `back_in_stock`, `launch`; `waitlist_batches(sku_id, batch_no, notified, created_at)`. PII: P2 (user ids); retention: episodes 13 months then aggregated (VR-TEAM-02).
API: no new shopper write routes except `PUT /v1/me/store-reminder-optouts/{storeId}` and `DELETE`; preferences through existing `PATCH /v1/me/notification-preferences` (`BAG_REMINDERS`); admin `GET/POST /v1/admin/reminder-policy` (dual approval for `max_steps > 1`).
Workers: `bag-reminder.scan` every 5 min (candidates by `cart_lines.updated_at` index), `bag-reminder.release` via the notifications `ProcessDue`, `waitlist.batch` on `sku.back_in_stock`.
Kill switches: `kill.bag_reminders`, `kill.back_in_stock_alerts`, `kill.seller_push` (default blocked until comms providers are composed, ADR-0034).

---

## 6. Failure handling (cross-cutting)
| Failure | Handling | User-visible |
|---|---|---|
| Permission projection cache unavailable | read from DB; if DB unavailable, deny (fail closed) | 503 for seller routes |
| Entitlements unavailable at invite | fallback plan seats (ADR-0056) | 409 `seat_limit_reached` possible |
| Launch job misses a tick | next tick launches (idempotent by product version); alert if lag > 5 min | launch late by minutes, countdown shows "Launching shortly" |
| Stock import partial failure | per-row report; applied rows committed | report CSV |
| Search sync lag | PDP/bag re-read Postgres | none |
| Push provider down | N7 failover, critical alerts to email | inbox |
| Reminder rendered with stale price | re-render at release; drop if bag changed | none |

## 7. Security and abuse (STRIDE + OWASP API 2023)
- **Spoofing:** invite bound to contact blind index; FULL session with passkey/TOTP; ownership transfer needs step-up on both sides.
- **Tampering / API3:** strict Zod allow-lists; client cannot send `store_id` in body, `permissions` outside the catalogue, `launch_at` outside bounds, or any price in alerts/reminders.
- **Repudiation:** hash-chained audit for every team change; stock adjustments carry actor and reason.
- **Information disclosure / API1:** foreign store = 404; buyer contact only via `orders.buyer_contact` with reason-coded audit; waitlist and abandoned-bag data never identify shoppers to sellers; push text without PII.
- **DoS / API4:** rate limits per route; stock import size cap; alert rate limit per member.
- **Elevation / API5:** delegation rules 1.5; sensitive grants 1.6; self-edit forbidden; last owner protection.
- **API6 business flows:** invite spam (10/h per granter, 20 pending), mass "notify me" (30/min existing), launch-time bots ride the drop protections only if the product is in a drop; reminder abuse is not shopper-triggerable.
- **Insider threat:** a staff member exporting data needs `analytics.export` (watermarked, audited); a departing employee is removed with immediate session revocation.

## 8. Metrics, SLOs, acceptance

**Metrics:** team adoption (stores with >= 2 members), share of customised memberships, invite acceptance rate, time to accept SLA after the 18 h warning, missed-SLA rate (guardrail), alert open rate, mute rate by type, unreachable critical alerts (target 0), restock time after sold out, waitlist conversion, launch-on-time rate, reminder incremental conversion vs holdout, unsubscribe and complaint rates (guardrails).
**SLOs:** permission change effective p99 <= 5 s; seller alert event-to-push p95 < 30 s (critical) / < 2 min (operational); launch job lag p99 < 2 min; stock import of 5,000 rows < 60 s; availability facet staleness < 60 s.

**Acceptance (Gherkin, become tests):**
- Given an owner grants a Sales preset to B, when B calls the stock route, then 403; when B accepts an order, then 200.
- Given a manager tries to grant `finance.payout_account`, then 422 `sensitive_requires_owner`; given an owner grants it in a single-owner store, then it activates after 24 h unless cancelled, and the owner is notified on every device.
- Given a member is removed, when their 9-minute-old access token calls any store route, then it is refused within 5 s of removal.
- Given the store's plan allows 5 seats with 5 used, when an invite is sent, then 409 `seat_limit_reached` with `limit` and `used`.
- Given the last owner tries to step down, then 409 `last_owner`.
- Given a product is SCHEDULED for tomorrow 10:00 Cairo, then it cannot be added to a bag, shows "Coming soon" and a countdown, and becomes ACTIVE within 2 min of 10:00; after a second postponement no countdown is ever shown for it.
- Given a seller marks a SKU with 4 free units sold out, then `inventory_adjustments` has reason `marked_sold_out`, free = 0, open reservations still claim, and shoppers see "Sold out".
- Given a reservation expires on a sold-out SKU, then no back-in-stock notification is sent; given the seller adds 5 units, then the first 15 waitlisters are notified and the next batch only if stock remains after 30 min.
- Given 7 SKUs sell out within 3 minutes, then a stock.read member receives one push "7 items sold out".
- Given every orders.fulfil member muted all alerts, when an order approaches 18 h unaccepted, then the warning is still pushed to at least one member.
- Given a shopper without `marketing_push` consent leaves a bag, then no push is sent and an inbox entry may exist (N3); given consent, then exactly one reminder arrives (default policy), not between 23:00 and 09:00 Cairo, and none if they placed the order meanwhile.
- Given a reminder claims "only 2 left", then the free count was <= 5 at render; given the price rose since adding, the reminder never mentions price.
- Given a store with no previous-period sales, then growth is null and the UI shows "New".
- Given a store with 40 distinct buyers in the window, then repeat-customer rate is withheld.

## 9. VERIFY BEFORE LAUNCH items (added to the register as VR-TEAM-01..12)
| id | Item | Owner role |
|---|---|---|
| VR-TEAM-01 | Is a bag (abandoned-cart) reminder a marketing/direct-marketing communication under PDPL 151/2020 and Decision 816/2025 (consent per channel), or a service message; same question for explicitly requested back-in-stock and launch alerts | Legal / DPO |
| VR-TEAM-02 | Purpose limitation and lawful basis for using bag contents and checkout-attempt signals to trigger reminders; RoPA entry, retention of reminder episodes | DPO |
| VR-TEAM-03 | WhatsApp Business template category (marketing vs utility) for cart reminders, back-in-stock and seller operational alerts; opt-in evidence and STOP handling (extends VR-COMMS-03) | Legal / Backend |
| VR-TEAM-04 | Current App Store Guideline 4.5.4 text on promotional push and opt-in wording; any rule on a second persona (seller) inside the shopper app | Product / Legal |
| VR-TEAM-05 | Egyptian rules on unsolicited commercial SMS, email and messaging (e.g. NTRA or CPA guidance) beyond PDPL, including unsubscribe requirements | Legal |
| VR-TEAM-06 | Minimum age for seller staff accounts and whether 18 to 20 year-old staff may hold finance, payout or signatory powers (extends VR-08, B6) | Legal |
| VR-TEAM-07 | Processing of seller staff personal data (identity, devices, session and audit logs): controller/processor split with the seller, DPA wording, employee-monitoring limits, retention of staff audit logs | DPO / Legal |
| VR-TEAM-08 | Legal effect of ownership transfer and signatory change in Seller Center versus the Seller Agreement party; KYC re-verification needed; who may change the payout account | Legal / Ops |
| VR-TEAM-09 | CPL 181/2018 and Executive Regulation 822/2019: "coming soon" listings with launch dates, countdowns, "restock expected" dates and pre-launch waitlists as advertising claims | Legal |
| VR-TEAM-10 | Scarcity statements in reminders ("only N left", "price dropped since you added"): permissibility and required wording under CPL 181/2018 (extends VR-07) | Legal |
| VR-TEAM-11 | Expo push relay for seller and shopper notifications: payload content leaving the region, transfer basis (extends VR-COMMS-01, VR-02) | DPO / Mobile |
| VR-TEAM-12 | Sharing any aggregate abandoned-bag or waitlist counts with sellers (k >= 50) under PDPL and the seller DPA | DPO |

## 10. Owner decisions (ADR-0058 T-D1..T-D12)
| # | Decision | Default until decided |
|---|---|---|
| T-D1 | Preset role names (AR/EN) and contents; is "Sales" the orders role | Section 1.3 table |
| T-D2 | Custom permission sets available on every plan, or tier-gated | Every plan (least privilege is a security control, ADR-0056 "no entitlement weakens a control") |
| T-D3 | Seats per tier (ADR-0056 D2); do owners and pending invites count | Owners not counted, pending invites counted |
| T-D4 | Sensitive grants: second-owner approval + 24 h delay (default), owner + step-up only, or Z-OUTLET Ops approval | (b) in 1.6 |
| T-D5 | Email invitations in addition to phone | Phone only |
| T-D6 | Bag reminder ladder: once (master prompt default) or multi-step (e.g. 1 h / 24 h / 72 h); first delay | Once, 3 h |
| T-D7 | May sellers opt their store out of bag reminders; may sellers see aggregate abandoned/waitlist counts | Opt-out allowed; counts not shown |
| T-D8 | Allow seller "restock expected" date label | Off |
| T-D9 | Allow countdowns for coming-soon products at all | Allowed under 2.5 rules |
| T-D10 | Default seller low-stock threshold, digest time, coalescing windows, critical classes | 5 units, 09:00 Cairo, 5 min |
| T-D11 | Holdout share and experiment duration for reminders | 10%, 4 weeks |
| T-D12 | Seller alert channels beyond push/inbox/email (WhatsApp, SMS) and who pays | Push, inbox, email; SMS only critical with a daily cap |

## 11. Work packages and tiers
| WP | Scope | Tier |
|---|---|---|
| T-WP0 | Owner decisions T-D1..T-D12; counsel VR-TEAM rows | owner + counsel |
| T-WP1 | `packages/policy`: permission catalogue, `brand_permission` grant kind, effective-set function, presets, legacy-equivalence property test | architect signs signatures and properties; builder implements; tester (property + mutation >= 80% on `packages/policy`); **chief-reviewer checkpoint (authz)** |
| T-WP2 | Migration: `seller_permission_keys`, `seller_role_presets`, membership columns, invite consolidation (expand/contract over 2 releases), approvals, transfers, security policy + RLS + `data_inventory.yaml` | builder; architect reviews migration plan |
| T-WP3 | Team routes, delegation rules, sensitive grant flow, ownership transfer, session revocation on removal, audit | builder; tester writes the 20 negative rows (1.15) |
| T-WP4 | Seller web team pages + mobile brand-mode team screen (AR/EN, RTL, permission checklist UI) | builder (UX principles) |
| T-WP5 | Catalog: `SCHEDULED` status, launch job, availability projection, mark sold out, restock label, channel sync holds | builder |
| T-WP6 | Stock CSV import (dry run, apply, report) | builder |
| T-WP7 | Search-sync facets `availability`, `listing_status`; PDP and store page sections | builder |
| T-WP8 | Seller alerts: consumer, recipients resolution, prefs/mutes/quiet hours/digest, coalescing, seller push tokens, inbox | builder; architect reviews the critical-coverage rule |
| T-WP9 | Revenue definitions: analytics `growth`, `finance/summary` from the ledger, nightly facts-vs-ledger check | builder; **chief-reviewer** on the ledger-backed summary (money display) |
| T-WP10 | Bag reminders and waitlist batching: episodes, scan worker, policy table with dual approval, opt-outs, holdout, kill switches, templates AR/EN | builder; DPO review before enabling; tester for content-truth property tests |
| T-WP11 | Mobile: seller push registration, persona routing, quick restock, alert settings | builder |
| T-WP12 | Quick fixes: i18n keys, event taxonomy rows, authz-matrix doc rows | quick-fix |

## 12. Test plan
Property (fast-check): legacy-role equivalence (1.3); delegation never yields a permission the granter lacks; effective set is monotone under restrictions; availability roll-up consistent with counters for random sequences of reserve/claim/release/adjust; back-in-stock never fires on reservation release; growth null iff prev = 0; reminder content never states a count > 5 or a price claim when price rose. Mutation >= 80% on `packages/policy` changes and the reminder content builder. Integration: every new route with the negative rows of 1.15. PGlite RLS contract tests for new tables. E2E: Playwright (team invite, permission edit, stock import), Maestro (quick restock, alert mute, notify me, deep link from reminder). Load: k6 for the reminder scan (1M bags) and stock import.

### Wiring requirements (chief-reviewer findings, pure layer in `packages/policy/src/seller-team.ts`)
The policy layer is pure and trusts its inputs. Before wiring into `apps/api`:
1. **Owner count race (finding 1).** Recount active owners inside the same transaction that applies any owner-affecting change (remove, demote, step-down, leave, transfer), under `SELECT ... FOR UPDATE` on the store's owner memberships or `pg_advisory_xact_lock(hashtext(store_id))`. Add a DB constraint or deferred trigger that rejects any transition leaving zero active owners (until `OFFBOARDED`).
2. **Caller contract (finding 8).** Pass only ACTIVE memberships of ACTIVE seller users. Pending/removed/suspended members are never passed to `decide*`. Sensitive-grant approvals carry `requested_at` and `expires_at`; a sweeper moves expired PENDING rows to EXPIRED, and `decideGrantApproval` also refuses past-expiry rows. Approvers need `ownerSinceMs` (from `owner_since`) no later than the request creation time; people are compared by seller user id.
3. **Owner grants.** Promotion to owner and acceptance of an ownership transfer go through `decideOwnerGrant` (second-owner approval, or 24 h delay for a single-owner store); the member is not an owner until activation. Owner permissions are never edited via `decidePermissionChange` (owners change only by transfer or step-down).
4. **API modules to migrate** from `g.kind === "brand"` role lists to `decide()` with `brand_permission` grants: returns, tax-eta, seller-settings, seller-analytics and sizing resolvers, the promotions authorizer, and the ~15 `storeIdsOf` helpers (RLS storeIds already include `brand_permission` in `dbSessionContext`).
5. **Open owner decision.** Whether the legacy `manager` role keeps `promotions.write` de facto (today a manager's access to promotions is implied by the authorizer's role list; the legacy mapping grants it to owner only). Default until decided: owner only, which narrows manager access, so decide explicitly before migration.
