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
