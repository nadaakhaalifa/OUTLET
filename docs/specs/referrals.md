# Referrals (spec section 15.4)

Status: Phase 1, synthetic data only, in-memory and Kysely adapters, nothing deployed · Module: `apps/api/src/modules/referrals` · Pure rules: `packages/domain/src/referrals` · Migration: `0026_referrals.sql` · Privacy: `docs/privacy/data_inventory.yaml` (`referral_codes`, `referrals`)

Scope is the core of 15.4 only: codes and deep links, the friend offer, the referrer reward after the return window, caps, eligibility and fraud rules. Creator/affiliate program (`creator_accounts`, `affiliate_clicks`, `commissions`) is out of scope.

## Hard limit
This module never posts to the ledger and never issues credit. A reward leaves as an **intent** on the outbox (`referral.reward_earned`, `referral.plus_month_earned`) in the same transaction as the settlement. The rewards / store-credit / subscriptions modules decide whether and how to issue, and dedupe on `idempotency_key`.

## Flow
1. `GET /v1/me/referral` lazily creates the caller's code (8 chars, Crockford base32 from the CSPRNG) and returns the code, deep link, counters, milestone progress and, for a referred friend, the offer.
2. The friend opens the deep link, signs up, then `POST /v1/referrals/attribute {code}` (idempotent, rate limited, App Attest asserted).
3. Eligibility is evaluated; the result is recorded as `attributed` or `rejected` but the caller always gets `200 {attributed: true}` for any business rejection (no oracle). An unknown code is 404, a missing attestation is 403.
4. Checkout asks `QuoteRefereeOffer(userId, subtotal)` for the friend discount (150 EGP when the first-order merchandise subtotal is at least 600 EGP). Applying it is the promotions engine's job.
5. When the orders module publishes `OrderClosed` (return window over) for the friend's first order, `HandleOrderClosed` settles through the inbox: reward intent, or rejection with a reason.

## Rules (configurable, proposed defaults in `DEFAULT_REFERRAL_CONFIG`)
| # | Rule | Default |
|---|---|---|
| R1 | Friend discount, first order | 15,000 piastres (150 EGP) |
| R2 | Minimum first-order merchandise subtotal | 60,000 piastres (600 EGP) |
| R3 | Referrer reward, only after the friend's order is CLOSED and not refunded | 10,000 piastres (100 EGP) |
| R4 | Milestone: every 10th rewarded referral also emits a Plus month intent | 10 / 1 month |
| R5 | Cap: max rewarded referrals per rolling window | 50 / 365 days |
| R6 | Friend: new phone, no prior order, 18+, device not shared with the referrer | |
| R7 | Referrer: active and at least one delivered order (checked at settlement) | |
| R8 | Payment fingerprint (SHA-256) of the friend's order must differ from the referrer's | |
| R9 | COD first orders reward only after delivery and close (`cod_not_delivered` otherwise) | |
| R10 | Cluster: users linked by a shared device or payment fingerprint form a union-find component; size > N withholds the reward | N = 3 |
| R11 | One referral per friend; first attribution wins | |
| R12 | Self referral (same account or shared device) is recorded as `rejected`, answered as success, never rewarded, emitted as `referral.attribution_rejected` (logged) | |

Check order at settlement is part of the contract (`decideSettlement`): status, first order, refunded, minimum, delivered, referrer active, fingerprint, referrer delivered order, cluster, cap.

## State machine
`attributed -> rewarded | rejected`; both are terminal (`transitionReferral` throws `InvalidReferralTransitionError`).

## Data
`referral_codes(id, owner_user_id UNIQUE, code UNIQUE, created_at, disabled_at)` and `referrals(id, code_id, referrer_id, referee_id UNIQUE, status, reject_reason, referee_device_hashes jsonb, order_id, payment_fingerprint_hash, reward_amount bigint, reward_currency, attributed_at, settled_at)`. Device and fingerprint values are SHA-256 hex only. CHECK constraints tie `reject_reason` to `rejected`, `reward_amount` to `rewarded`, `settled_at` to a final status, and allow `referrer_id = referee_id` only when rejected.

RLS: owners read their code; parties read their referral; a friend inserts only their own attribution; updates and code resolution run as `system`.

## API
| Method and path | Auth | Idempotent | Rate limit |
|---|---|---|---|
| `GET /v1/me/referral` | buyer, self | n/a | 60/min user |
| `POST /v1/referrals/attribute` | buyer, self, App Attest | required | 10/min user, 30/min IP |

## Events
Outbox (aggregate `referral`): `referral.attributed`, `referral.attribution_rejected`, `referral.rejected`, `referral.reward_earned`, `referral.plus_month_earned`. Payloads hold ids, amounts as strings and a reason; no contact data. Consumed: `OrderClosed` (inbox consumer `referrals.order_closed`).

## Failure handling
Settlement is one transaction: inbox insert, referral update guarded by `status = 'attributed'`, outbox rows. A replayed message returns `duplicate`; a second message for an already settled referral changes nothing and emits nothing.

## Security and abuse
BOLA: no object id in either route; data is keyed by the token subject. Seller-audience token 401, suspended subject 403. SMS-free, so no pumping; abuse vectors are self referral, device farms and shared cards (R8, R10, R12). Rate limit fails closed.

## Known gaps
* Closed (was: cap read before settlement). `settle` now takes a `RewardGuard` and decides cap and Plus-month milestone inside the settlement transaction, serialised per referrer (`pg_advisory_xact_lock(hashtext(referrer))` in Postgres, a synchronous section in memory), recounting under the lock. It returns `rewarded | capped | already_settled | recorded` and the months granted. A capped closure settles the referral as `rejected(cap_reached)`. Covered by concurrent contract cases on both adapters.
* Identity (age, new phone, devices, fingerprints, delivered orders) comes from `ReferralIdentityPort`; the production adapter belongs to users/orders.
* App Attest verification is a port; the production adapter belongs to auth.
* Cooling off of a rewarded referral after a later refund is not modelled (the reward is an intent already emitted); the rewards module owns clawback.
