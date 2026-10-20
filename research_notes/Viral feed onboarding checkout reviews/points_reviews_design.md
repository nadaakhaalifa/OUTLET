# Points economy and review data model for the marketplace review system

Scope note: read-only repo analysis plus a few web searches (6 repo reads, 3 web searches). Repo line numbers are from files read on 2026-10-16. Web sources are secondary (vendor blogs, news); primary reports were not retrieved. Illustrative AOV and margin numbers are my assumptions and are labelled as such.

## 1. What exists today (repo audit)

### Takeaway
A review module, a rewards/coins module, store-credit, ledger and promotions all exist and are composed. "10 points per approved review" is already implemented in different units: a photo review with size info grants 7,000 coins = 70 EGP at the default rate, which is likely far too generous. The real gaps are: reward timing (fires at publish, not after the return window), no eligibility floor (order value / item price), no caps, no device/payment dedupe on reviews, no media table, no votes, no mobile review UI, and no points-to-voucher/free-delivery catalog.

### Cited Findings (repo)
- Reviews spec: `docs/specs/reviews.md` (flow, rules, state machine SUBMITTED -> AUTO_CHECKED -> PUBLISHED | HELD | REJECTED, API table, events, known gaps). Rules say coins are never tied to rating; `reviewRewardIntent()` has no rating parameter and is emitted once (`reward_intent_at`). Summary is null below 5 published reviews. Review window 180 days is an unverified default.
- Reviews table: `packages/db/migrations/0030_reviews.sql` lines 19-45: `order_line_id` UNIQUE (line 41), rating 1-5, title <=80, body 10-2000, `purchased_size`, `fit` (too_small|ok|too_large), `fit_area`, `photo_ids` jsonb max 5 (lines 31-32), status check (33-34), `hold_reason`, `reward_intent_at` (37). Sibling tables: `review_replies` (54), `questions` (68), `answers` (95), `ugc_reports` (114, unique per reporter, line 121), append-only `moderation_log` (126). RLS from line 140: published world-readable, author sees own.
- Photos are only opaque `photo_ids`; ownership check via a port: `apps/api/src/modules/reviews/application/reviews.ts` lines 90 and 141 (`photos.areOwnedImages`). No `review_media` table, no phash, no EXIF/moderation-label storage in the review module. A `product-media` module exists but was not inspected.
- Reward intent is emitted on PUBLISH, not after the return window: `apps/api/src/modules/reviews/application/moderation.ts` lines 51-60 (`review.reward_intent`, idempotency key `review-reward:${r.id}`). Fit event `review.fit_feedback_submitted` at lines 40-49. Domain: `packages/domain/src/reviews/rules.ts` lines 120-143.
- Rewards consumer: `apps/api/src/modules/rewards/adapters/triggers.ts` lines 33-38, 96-97 (Zod boundary); `apps/api/src/modules/rewards/application/triggers.ts` lines 48-57 award `photo_review` coins with sourceRef = reviewId (idempotent per review).
- Coin amounts: `packages/domain/src/rewards/config.ts` lines 63-88: `piastresPerCoin: 1n`, `purchaseBps: 100n` (1%), `plusBonusBps: 500n`, `reviewBaseCoins: 2_000n`, `reviewPhotoCoins: 3_000n`, `reviewFitCoins: 2_000n`, `maxCoinsPerEvent: 1_000_000n`, `expiryMonths: 12`, tiers silver 500,000 / gold 2,000,000 / black 5,000,000 piastres (5k/20k/50k EGP). Formula: `reviewCoins` in `packages/domain/src/rewards/coins.ts` lines 26-31. Max 7,000 coins = 7,000 piastres = 70 EGP per review. The spec file calls these "engineering proposals needing product sign-off": `docs/specs/phase2/06-rewards-coins-games.md` line 67.
- Ledger recipe: `packages/domain/src/rewards/entries.ts` lines 9-31. Grant = Dr `promo_expense_platform` / Cr `store_credit:{user}:cashback_coins` (builder `storeCreditGranted`, `packages/domain/src/chart-of-accounts/builders.ts` 399-415). Clawback = Dr store_credit / Cr promo_expense_platform (kind `coins_clawed_back`). Expiry = Dr store_credit / Cr (builder at builders.ts 418+; counter-account not read, likely promo expense reversal; verify). Idempotency keys `rewards:earn:{kind}:{sourceRef}` and `rewards:clawback:{refundRef}` (`apps/api/src/modules/rewards/application/coins.ts` lines 80, 133, 232).
- Coin service behaviour: ledger-first, award recorded as pending if the ledger is down and settled later (coins.ts 73-90, 118-144); proportional clawback, spent coins become debt netted from future earnings and never charged (coins.ts 146-222; spec 06 decisions 3, 53-55); per-lot expiry writes off only unspent part (coins.ts 245-289).
- Design decision recorded: coins are on-ledger store credit from award (option b), not off-ledger points: `docs/specs/phase2/06-rewards-coins-games.md` line 53.
- Redemption today: coins ARE store credit in `cashback_coins`, spendable at checkout with the soonest-expiry-first rule (`docs/specs/store-credit.md` line 15). `POST /v1/me/coins/convert` exists (`apps/api/src/modules/rewards/adapters/rewards.controller.ts` line 114) and in practice settles pending awards. No catalog of vouchers, free-delivery passes or Plus days redeemable with coins was found. Games can award vouchers (spec 06 line 13).
- VAT/accounting of coins is open: `docs/compliance/verify-register.md` line 89 (VR-P2-04); `docs/specs/ledger-chart-of-accounts.md` lines 189-190 (open items 1-3: VAT and accounting of coins/referral/goodwill, VAT base when platform funds a discount). Gift-card breakage unsupported (builders.ts comment at 417).
- Anti-abuse hooks present: spec 06 line 18 "abusive review farms -> reward withheld pending fraud graph" (spec only). Device and payment fingerprints stored as SHA-256 hex in `packages/db/migrations/0026_referrals.sql` (lines 10, 32, 34) for referrals only; nothing links them to reviews.
- Self-review block, contact-info hold, 3-reporter hold, report cap 20/day, rate limits: `docs/specs/reviews.md` rules table.
- Mobile: no review-writing or review-display feature found in `apps/mobile/src` (grep hits only wardrobe, size-profile "review" wording, checkout "review" step, brand-apply). `apps/shopper-web` mentions reviews in `view-models/product.ts` and SEO tests (display only). Status: `apps/api/src/production/bindings.ts` lines 70-71 mark reviews and rewards "composed". Coins stay disabled in production until VR-P2-04 (spec 06 line 66, flag `kill.rewards_coins`).
- Master spec: 15.2 sub-balances, 15.5 coins (12 months, clawback on return, tiers by 12-month net spend, 1 coin = 1 piastre when converted, coins for photo reviews with size info), 27 review guidelines (verified purchase only, no self-review, coins for any honest review, not positive ones), 10 fit feedback, T4 accounts `promo_expense_platform`, `store_credit:{user}:{sub}`.

### Inferences
- "10 points" has no home in the code. Cleanest mapping: keep coins as the only unit (option a), and make the UI display points = coins / 100 or similar, rather than a second currency (see section 2).
- Reward at publish conflicts with the stated principle that order coins award after the return window, and creates a farming window (buy, review, return). Defect: grant happens before the order line is CLOSED.
- Expiry accounting of coins is not "breakage" in the IFRS sense because coins are platform-funded credit, not a material right from a sale (see inference in section 2).

### Gaps
- Did not read: product-media module, promotions voucher issuance code, counter-account of `storeCreditExpired`, orders module's `CLOSED` event name for review gating.

## 2. Mapping "10 points per approved review": options and economics

### Takeaway
Recommend option (a) with a presentation layer: coins remain the single on-ledger unit; show "points" in the UI as coins divided by 100 (1 point = 1 EGP of credit = 100 coins) only if product insists on the "10 points" language; reduce review reward from today's 20-70 EGP to about 5-15 EGP, pay it after the return window, cap per day and month, and make the cost a rounded small share of AOV. A separate points currency (option b) adds a second liability and a conversion table with no gain; tiers (option c) should act only as multipliers on the coin amount.

### Cited Findings
- 1 coin = 1 piastre by default (config.ts 65); 10 points taken literally = 10 coins = 0.10 EGP (worthless), versus the current 2,000-7,000 coins per review. Source: repo, above.
- IFRS 15: points granted as part of a sale are a performance obligation only if they are a material right; transaction price is allocated by relative stand-alone selling price including likelihood of redemption; expected breakage is recognised in proportion to rights exercised. — [BDO](https://www.bdo.co.uk/en-gb/insights/business-edge/business-edge-2017/ifrs-15-in-the-spotlight), [RSM](https://www.rsmuk.com/insights/advisory/accounting-for-customer-loyalty-schemes), [Grant Thornton retail guide](https://www.grantthornton.co.nz/globalassets/1.-member-firms/new-zealand/pdfs/ifrs-guides/retail-industry.pdf). Secondary sources; I did not retrieve the standard or an IFRIC decision.
- Incentivised reviews inflate ratings: about 0.5 stars higher on identical products, and removing the incentive reduced sales while one-star reviews rose; disclosure alone did not protect shoppers. — [UF news on the 2023 study](https://news.ufl.edu/2023/08/incentivized-online-reviews-deceive-consumers/). ReviewMeta 2016 reported 4.74 vs 4.36 stars, methodology criticised. — [ReviewMeta coverage via ecommercebytes](https://www.ecommercebytes.com/2016/09/26/compensated-amazon-reviewers-cant-help-bias/). Incentives can raise text quality. — [INFORMS ISR](https://pubsonline.informs.org/doi/full/10.1287/isre.2022.1146).

### Proposed design (all numbers are proposals needing product and counsel sign-off; AOV/margin are my assumptions)
Assumptions: AOV 1,200 EGP merchandise; platform take rate about 12% = 144 EGP gross commission (assumption); store-credit redemption is cost to platform (funded by `promo_expense_platform`).

Option comparison:
| Option | Pros | Cons |
|---|---|---|
| (a) Points = coins, 1 coin = 1 piastre | Already built, ledger-first, clawback, expiry, one liability | Large integers in UI; current 7,000-coin default too rich |
| (b) Separate non-monetary points + catalog | Flexible rewards (free delivery, Plus days) | Second liability, unspecified accounting (possibly off-ledger, which ADR-0021 forbids: spec 06 line 53), more fraud surface |
| (c) Tiers | Retention, already built (tiers.ts) | Tier multiplier on review reward amplifies farming; use only a small cap multiplier |

Chosen: (a) with display scale. Rationale: ADR-0021/spec 06 reject off-ledger points because they leave an unrecorded liability.

Earn table (coins, 100 coins = 1 EGP; "points" in UI = coins / 100 if desired, so "10 points" = 1,000 coins = 10 EGP):
- Verified text review (>=40 chars): 500 coins (5 EGP)
- + photo (passes moderation): +500 (5 EGP)
- + fit info (size-bearing item categories): +300 (3 EGP)
- Max per review: 1,300 coins = 13 EGP. Today's default is 7,000 (70 EGP): 5.4x higher.
- Cost per review at the max = 13 / 1,200 = 1.1% of AOV; versus 70 EGP = 5.8% of AOV and 49% of gross commission (assumption-based). Even 10 EGP flat = 0.83% of AOV and about 7% of commission.
- Eligibility: order line net >= 300 EGP (assumption), delivered, return window closed (CLOSED), account age >= 14 days, phone verified, at most 1 rewarded review per order line (existing unique), at most 1 per product per user (variant dupes), cap 5 rewarded reviews per Cairo day and 20 per month, reward 0 for edits.
- Tier multiplier: Bronze 1.0, Silver 1.1, Gold 1.2, Black 1.25 on the review reward only, capped by `maxCoinsPerEvent`; or none (simpler, lower farming risk). Inference: no published benchmark for UGC-reward multipliers found.
- Expiry: existing 12-month `cashback_coins` lot expiry; expiring-soon notice 30 days (exists).
- Redemption: store credit at checkout (exists). Add catalog via voucher issuance rather than a new currency: e.g. 1,000 coins -> free-delivery voucher (value capped at one shipment fee), minimum redemption 500 coins, Plus days only if counsel and Apple Plan A permit (ADR-0004; Plus renewals via credit are excluded in gift-card rules, 15.1 prohibits gift cards buying Plus; apply the same to coins as the safe default).
- Liability and accounting (inference): coins awarded for a review are not consideration from a sale, so they are most plausibly a marketing/promo expense at grant (matches `promo_expense_platform` debit), with a store-credit liability until spent or expired; purchase-earned coins (1% cashback) are the ones that look like a material right under IFRS 15 and may need deferral of revenue. This split is an inference; treatment is VERIFY (VR-P2-04). Breakage reporting: derive from `coin_events` expire rows over grants per cohort.
- VAT: VERIFY. Do not assume VAT on grant or on expiry; record open items from ledger-chart-of-accounts.md lines 189-190.

Worked ledger examples (piastres; reward 1,300 coins = 1,300 piastres = 13 EGP is 1,300 piastres... note: at 1 coin = 1 piastre, 13 EGP = 1,300 piastres = 1,300 coins; the 100-coins-per-EGP display scale means the config would be `piastresPerCoin = 1` and award 1,300 coins; to display "points" divide by 100):
1. Earn (after approval and CLOSED): Dr promo_expense_platform 1,300 / Cr store_credit:u:cashback_coins 1,300. Key `rewards:earn:photo_review:{reviewId}`. Sum = 0.
2. Redeem partly at checkout, 800 piastres of a 25,000 order (existing hold/capture): Dr store_credit:u:cashback_coins 800 / Cr the order allocation accounts per `docs/specs/ledger-chart-of-accounts.md` line 123 example. Platform cost was recognised at grant; seller payable is unchanged (platform-funded).
3. Expire unspent 500 after 12 months: Dr store_credit:u:cashback_coins 500 / Cr promo expense reversal or breakage account (confirm builders.ts 418+). 
4. Clawback (review removed or order refunded within the window): if 1,300 remain, Dr store_credit 1,300 / Cr promo_expense_platform 1,300 (entry `coins_clawed_back`). If 800 already spent, reverse 500 and record 800 as `coin_debts` netted from future earnings, never charged (existing).

### Inferences
- The default 2,000/3,000/2,000 numbers look like piastres-of-EGP confusion (20/30/20 EGP); recommend halving or more before VR-P2-04 closes.
- UGC-reward benchmark numbers (EGP per review) were not found; the proposed amounts come from cost-share reasoning only.

### Gaps
- No retrieved IFRIC agenda decision, no academic loyalty-economics source on optimal reward size, no Egyptian consumer-law limits on coin expiry (VR-P2-04).

## 3. Anti-abuse economics

### Takeaway
Pay late, small and capped; gate on order value and verified delivered, non-returned line; tie rewarded reviews to device and payment fingerprints; hold payout when the fraud graph flags a cluster.

### Cited Findings
- Incentive-driven rating inflation is documented (UF study, section 2), so rewards must not depend on rating (already enforced in code).
- Referral fingerprint hashing precedent: `0026_referrals.sql` lines 10, 32-34.
- Moderation hold on contact info, toxicity, image flags, 3-reporter hold: `docs/specs/reviews.md`.

### Proposed controls
- Reward trigger moves from `PUBLISHED` to `PUBLISHED AND order_line CLOSED AND not refunded`. Implementation: keep the `review.reward_intent` event but add a `review_reward_awards` row in PENDING at publish and release on `order.closed` for that line (or consume `order.closed` joined with published review).
- Farming economics: a ring buys a 300 EGP item, reviews, keeps it, earns 13 EGP: the ring pays item cost (net of resale/return), so the floor on order value is the main cost to the attacker; at 300 EGP the platform pays 4.3% of the item price in reward; if the order is returned, clawback.
- Device/payment dedupe: store `device_hash` and `payment_fingerprint_hash` (SHA-256 hex, as in 0026) on the award row; deny reward if the reviewer shares a device or instrument with the seller's staff or with more than 2 other rewarded accounts in 30 days. Same-seller concentration cap: at most 3 rewarded reviews per user per store per 30 days.
- Moderation cost: use auto-moderation first; a human queue only for HELD. Assume 0.30 EGP per auto-check and 3 EGP per human review (assumptions); budget about 0.5 EGP per review blended.
- Reward withheld, not revoked, pending fraud graph (spec 06 line 18).

### Inferences
- Thresholds (300 EGP, 5/day, 20/month, 3 per store) are my proposals; calibrate on data.

### Gaps
- No fraud-loss benchmarks for UGC rewards found.

## 4. Data model, API, events (proposal extending 0030)

### Takeaway
Reuse `reviews`, `ugc_reports`, `moderation_log`, `review_replies`; add `review_media`, `review_votes`, `review_reward_awards` (the "points_awards" table) and a few columns. Explicit state machines for review (exists) and award (new).

### Proposal
- `reviews` add: `language` (ar|en), `edited_at`, `moderation_scores jsonb`, `status` extend with `REMOVED` (author delete/takedown) and a column for `closed_at_snapshot` if needed. Existing statuses differ from the brief (PENDING/APPROVED): map SUBMITTED/AUTO_CHECKED = pending, PUBLISHED = approved.
- `review_media(id, review_id FK, storage_key, phash, exif_stripped bool, labels jsonb, status SUBMITTED|PUBLISHED|REJECTED, created_at)`: PII class P2; photos may contain faces and addresses. phash for duplicate/stock-photo detection across users and sellers (master spec 9.2 pHash). Replace `photo_ids` jsonb over time.
- `review_votes(review_id, user_id, helpful bool, created_at, PRIMARY KEY (review_id, user_id))`; one vote per user; no self vote; rate limit 60/min.
- `review_reward_awards(id, review_id UNIQUE, user_id, coins, status PENDING|GRANTED|CLAWED_BACK|WITHHELD, coin_event_id, journal_entry_id, device_hash, payment_fp_hash, created_at, granted_at)`. State machine: PENDING -> GRANTED | WITHHELD; GRANTED -> CLAWED_BACK; WITHHELD -> GRANTED (after fraud review). Backed by the existing `coin_events` table, which already has unique source and a ledger entry id; this table adds eligibility and fraud evidence.
- Replies exist (`review_replies`, one per review). Reports exist.
- API (additions): `POST /v1/reviews/{id}/votes` (buyer, idempotent), `POST /v1/orders/lines/{id}/review/media` (signed upload, EXIF strip, AV scan), `GET /v1/me/review-rewards`, admin `POST /v1/admin/review-rewards/{id}/release|withhold` (dual approval above threshold). Existing routes in the spec's API table stay.
- Events (outbox, ids and enums only): `review.published` (exists), `review.unpublished`, `review.media_moderated`, `review.vote_cast`, `review.reward_eligible`, `review.reward_granted`, `review.reward_clawed_back`; analytics `review_submitted`, `review_photo_added`, `review_helpful_voted` consent-aware. Inbound consumers: `order.closed`, `order.refunded`, `return.completed`.
- AuthZ and tests: buyer A cannot edit buyer B's review (404, RLS `reviews_author_update`, 0030 line 147); seller cannot approve own reviews (moderation routes are admin audience; seller token returns 401/403; self-review 422); another store's review 404; shopper on admin route 403. Idempotency key required on create.
- Retention: P2 text and photos until account deletion; pseudonymise on deletion (data_inventory already tags `reviews`); raw rejected images purged in 30 days (proposal).

### Inferences
- Extending rather than replacing 0030 follows the expand/contract rule in the master spec.

### Gaps
- Exact `product-media` reuse not checked; storage and AV-scan adapters not inspected.

## 5. Review features for trust and conversion

### Takeaway
Evidence supports showing reviews early, with verified badges and a rating in the 4.2-4.5 band looking more credible than 5.0; I could not retrieve Baymard or Bazaarvoice primary data.

### Cited Findings
- Spiegel Research Center / PowerReviews: purchase likelihood for a product with five reviews is reported as 270% higher than with none; lift larger for higher-priced items; peak purchase likelihood at 4.2-4.5 stars; verified-buyer badge reported to add about 15% — all via [Lipscore summary](https://lipscore.com/blog/product-reviews-increase-your-online-sales-by-270/) and [ConsumerAffairs](https://brands.consumeraffairs.com/resources/star-rating-impact). Secondary vendor sources; the report itself was not retrieved. Treat 380%, 190% and 15% as unverified.
- Incentive disclosure is not enough; platform-selected reviewer programs gave less bias (UF study above).

### Inferences
- Features aligned with the repo and spec: verified-purchase flag (exists), photo reviews, helpful votes, fit summary (Beta-Binomial with n>=20 per spec 10), sort by newest/helpful/photo, seller reply (exists), AR/EN display with language filter, summary null under 5 reviews (exists and consistent with CPL honesty rule).
- LLM summaries: use `llm-gateway`; reviews are untrusted data in delimited fields (LLM01), no P3 data, output schema-constrained with no tools, labelled "AI summary", regenerate on publish batches; show only above a minimum count.
- Never show a "photo review" reward in a way that implies positive reviews earn more (spec 27).

### Gaps
- Baymard review UX findings and Bazaarvoice/PowerReviews studies were not retrieved; no Arabic-specific review UX source found.

## 6. Test plan and phasing

### Takeaway
Most domain tests exist for coins (clawback proportionality, debt netting, expiry); new work focuses on the award state machine, eligibility, and the late-reward timing.

### Proposed tests
- Unit: eligibility function (order value, delay, caps), award state machine all transitions and invalid transitions throw; `reviewCoins` no rating parameter (exists).
- Property (fast-check): an award is granted at most once per review for any replay/interleaving of publish, close, refund events; ledger entries for any sequence balance to zero; grant then clawback restores the balance (for unspent coins) or creates debt equal to the spent amount; sum of clawbacks never exceeds grants; daily/monthly caps never exceeded.
- Mutation target >= 80% (Stryker) on `reviewCoins`, eligibility and award state machine, per master spec A2.10 (ledger/reward math is in scope).
- Integration: negative authorization cases from section 4 on every new endpoint; RLS tests in pglite as in `migration.test.ts`; webhook/event replay twice gives identical state.
- E2E: Maestro (write review with photo, see pending, see reward after delivery plus window), Playwright on seller reply.
- Load: k6 on review list reads.
- Phases (builder tier Sonnet after architect/Fable sign-off on money; checkpoint chief-reviewer because it touches money):
  1. Decide numbers and VAT/accounting stance (owner, counsel; VR-P2-04). Reduce config defaults.
  2. Move reward to post-CLOSED; add `review_reward_awards`, caps, floors, fingerprints.
  3. `review_media` with phash, EXIF, moderation labels; mobile write/read review UI (does not exist).
  4. Votes, sorts, fit summary, AR/EN display.
  5. Voucher/free-delivery redemption catalog; LLM summaries.

### Gaps
- Real classifiers (toxicity AR/EN, image) are fakes per reviews spec; thresholds unvalidated on Egyptian data.
