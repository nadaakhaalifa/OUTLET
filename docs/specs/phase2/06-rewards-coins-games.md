# Spec 06: Rewards, coins, tiers, light games

Refs: §15.5, §15.2, §18, §B2, ADR-0021. Phase 2. Games behind kill switch `games` (default OFF until VR-09).

## Flow
Earn coins: delivered and not-returned purchases, photo reviews with size info, size-profile completion, fit feedback, referrals, streaks, challenges. Convert coins to store credit (`cashback_coins` sub-balance). Tiers Bronze/Silver/Gold/Black by 12-month net spend. Games: daily spin, scratch card after delivery.

## Rules
- 1 coin = 1 piastre of store credit on conversion (config, versioned). Coins expire 12 months rolling; expiring-soon notice 30 days ahead (real expiry only).
- Earn posting is ledger-first (ADR-0021): coin liability is `store_credit:{user}:cashback_coins` once awarded; coins on an order award after return window closes, and are clawed back (reversing entry) if returned.
- Plus +5% coins is an entitlement (`commerce_benefits.coins_plus_5pct`).
- Tier from net spend (orders delivered minus refunds) rolling 12 months; tier drop only at monthly evaluation, with 30-day notice.
- **Games:** free to play, no purchase required or influenced, odds table published in-app and versioned (`game_odds_versions`), RNG server-side CSPRNG, outcomes coins or vouchers only, never cash; daily cap per user; no paid chance mechanics, no loot boxes. Odds change needs admin dual approval and publishes before effect. Mystery boxes are drops, not games (spec 07).
- Reviews rewards for any honest review, not positive ones (§27).
- No fake urgency in streaks: streak copy shows real reset time.

## Edge cases
Order returned partially -> proportional clawback; clawback when coins already spent -> negative goodwill debt netted from future earnings, never charged; account merge; abusive review farms -> reward withheld pending fraud graph; spin on app clock manipulation -> server time; timezone Cairo day boundary.

## Data
`coin_events(id, user_id, kind, amount, source_ref, journal_entry_id, expires_at, created_at)` P2 · `tier_status(user_id, tier, net_spend_12m, evaluated_at)` P2 · `challenges(id, rule jsonb, window, reward)` P1 · `game_plays(id, user_id, game, odds_version, outcome, reward_ref, ts)` P2 · `game_odds_versions(id, game, table jsonb, published_at)` P0.

## API
`GET /v1/me/rewards` (owner, 60/min) · `POST /v1/me/coins/convert` (owner, idem, 10/h) · `POST /v1/games/{game}/play` (owner, App Attest, idem, 3/day) · `GET /v1/games/{game}/odds` (public, 60/min) · `CRUD /v1/admin/rewards/config` (admin, dual approval, audit).

## Events
`coins.earned`, `coins.clawed_back`, `coins.expired`, `tier.changed`, `game.played`. Analytics `coins_earned`.

## Failure handling
Award saga idempotent on `(source_ref, kind)`; expiry sweeper batches with SKIP LOCKED; nightly reconcile of coin projection vs postings (alert on drift).

## Security and abuse
Device/IP/instrument graph for farming; attest on play; rate limits; BOLA; odds table immutability; CSPRNG test (statistical chi-square job in CI on seeded RNG interface).

## Metrics
Coin earn/burn ratio, redemption rate, tier distribution, games participation; guardrails: review-quality score, fraud rejection rate, return rate.

## Acceptance
```
Given a returned order, Then coins earned on it are clawed back with a reversing entry and balance reconciles.
Given a game play, Then the outcome distribution over 1M simulated plays matches the published odds within tolerance.
Given games kill switch off, Then play returns 503.
Given coins older than 12 months, Then they expire and appear in store-credit history.
Given the odds page, Then it shows the same version used by the latest play.
```

## Build notes

Built in `packages/domain/src/rewards`, `apps/api/src/modules/rewards`, migration `0041_rewards.sql`. Money core consumed only through ports with fakes (`LedgerPort`, `StoreCreditPort`, `EntitlementPort`, `VoucherPort`, `RewardsSwitchPort`, `AttestationPort`, `ConfigApprovalPort`).

### Resolutions of spec gaps and contradictions

1. **"Ledger-first at award" vs "convert endpoint".** The spec says the coin liability is `store_credit:{user}:cashback_coins` once awarded and also exposes `POST /me/coins/convert`. Options: (a) coins are off-ledger points and credit is posted at conversion; (b) credit is posted at award and conversion is a settlement step. Chose (b): (a) leaves an unrecorded liability, which ADR-0021 forbids. Award posts `Dr promo_expense_platform / Cr store_credit:{u}:cashback_coins` (`piastres = coins x piastresPerCoin`, rate snapshotted per event). If the ledger is unavailable the award is recorded with `journal_entry_id = NULL` (pending settlement) and posted later by `convert`, the sweeper, or a clawback, always under the same idempotency key `rewards:earn:{kind}:{source_ref}`. `convert` therefore settles pending awards and returns the live balance; it never double posts.
2. **When order coins award.** On the `order.closed` intent (return window closed, kept). No separate pending state. Clawback still exists for refunds after close (defects up to 30 days; payouts close later).
3. **Clawback.** Proportional to refunded net merchandise, half to even once through `divideRoundHalfEven`, a full refund claws the exact remainder, and the sum can never exceed what was earned (property tested). The reversing entry (`Dr store_credit / Cr promo_expense_platform`) covers min(clawed, lot remaining, live balance). The rest becomes `coin_debts` (never charged) and is netted from future earnings; only the net amount is posted. A refund consumed by debt never posts a ledger entry.
4. **Expiry attribution (2 options).** (a) Track per lot consumption inside store credit; (b) infer: spend takes the soonest expiring credit first (spec 15.2), so credit already spent is attributed to the oldest lots, and only the unspent part of a due lot is written off. Chose (b): no cross-module coupling beyond `cashbackBalance`, matches the documented spend order, and is bounded by the live balance (property tested). Each due lot gets exactly one `expire` row (amount 0 when fully spent) so it never reappears. The write off goes through `StoreCreditPort.expireCoins` so it appears in store-credit history.
5. **Auditable draw with disclosed odds (2 options).** (a) Plain CSPRNG roll plus an audit log; (b) HMAC-SHA256 keyed by a fresh CSPRNG server seed over `user|game|cairo_day|seq|odds_version`, rejection sampled to ppm. Chose (b): stored seed, seed hash, roll and odds version let an auditor re-derive any play. The seed is revealed with the result, so this is audit-grade only: it offers no player-verifiable guarantee, because the seed hash is not committed to the player before the draw. All user-facing wording says "disclosed odds" and makes no verifiability claim (B-7, covered by a copy test). A commit-reveal (seed hash published with the entitlement, seed revealed after the play) is the upgrade if counsel (VR-09) requires pre-commitment.
6. **Idempotent play and crash safety.** A play row is inserted first (unique on `(user, game, intent_id)`, the request's Idempotency-Key), then effects (coin award or voucher, both idempotent on `play:{id}`), then `settled_at`. A retry resumes unsettled plays, so the outcome never changes on retry.
7. **Daily cap and clock.** Cairo calendar day from the server clock; `(user, game, day_key, seq)` unique decides concurrent plays. Config `dailyPlaysPerGame` (1..3, default 1); the route also has the spec's 3 per day rate limit.
8. **Scratch card.** One entitlement per closed order (`game_entitlements`), consumed by a play whose `source_ref` is that order (unique per game).
9. **Streaks.** Defined as consecutive Cairo calendar months with a closed, kept order (no daily check-in, so no artificial urgency). The reset instant shown is the real end of the month in which the streak would break. Milestones pay once per run: `streak:{user}:{start_month}:{months}`.
10. **Challenges.** Rule type `orders_closed` (count within window) only; pays once per `(challenge, user)`.
11. **Referral reward.** The referrals module emits an amount of `referral_credit` (piastres). It is issued here into the `referral_credit` sub-balance (6 month expiry per store credit rules), recorded as coin event kind `referral` for one history and one clawback path. It is not converted into cashback coins.
12. **Tier drops.** Upgrades apply immediately (also on the order path). Drops only in the monthly job: announce with 30 days notice (`pending_tier`, `pending_effective_at`), apply at the first evaluation after that date if spend is still lower, cancel if it recovers. Net spend is delivered minus refunds, rolling 12 months, floored at 0.
13. **Odds changes.** Versioned and immutable (`game_odds_versions`: SELECT and INSERT only). Dual approval is checked through `ConfigApprovalPort` (two approvers other than the requester). A version is effective `oddsPublishLeadHours` (default 24) after publication; the public odds page returns the version in force and upcoming ones. No outcome kind can be cash (domain validation and a CHECK).
14. **Switches.** `kill.games` (existing, default OFF) gates games. Coins earning needs a separate switch because spec plan row 11 and VR-P2-04 disable coins in production until rates are verified: the module reads `kill.rewards_coins` through `FlagRewardsSwitch` (flag not yet in the registry, see needs). Both fail closed. In-memory dev defaults: games OFF, coins ON.
15. **Defaults needing product sign-off** (engineering proposals, all admin-configurable): purchase rate 1% of net merchandise, Plus multiplier +5% of earned coins, review 2,000 / +3,000 photo / +2,000 fit coins, profile completion 5,000, fit feedback 1,000, tiers from 5,000 / 20,000 / 50,000 EGP, streak milestones 3/6/12 months. 1 coin = 1 piastre.
16. **Added tables** beyond the spec data list: `reward_config_versions`, `coin_debts`, `spend_events`, `game_entitlements`.
17. **Authorization.** Shopper routes are `AuthenticatedSelf` (no object id, data keyed by the token subject: no BOLA surface). Admin routes use the `admin_console` resource plus a handler role check (`marketing`, `finance`, `super_admin`). The body is validated before the role check (same order as reviews), so a wrong-role admin with a malformed body gets 400, not 403.

### Open verify items touched
VR-09 (games legality, odds disclosure, pre-commitment), VR-P2-04 (coin tax, expiry, VAT base of platform funded coins), and the clawback-of-spent-coins policy (debt, never charged) needs counsel confirmation under CPL 181/2018.
