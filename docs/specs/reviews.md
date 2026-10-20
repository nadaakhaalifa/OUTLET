# Reviews, Q&A and review guidelines (spec sections 5 and 27)

Module: `apps/api/src/modules/reviews`. Pure rules: `packages/domain/src/reviews`. Migration: `packages/db/migrations/0030_reviews.sql`.

## Flow
1. Courier confirms delivery. The buyer opens the order line and writes a review: rating 1 to 5, body, optional title, optional fit (too_small, ok, too_large) and fit area, optional photos (up to 5 upload ids).
2. The purchased size label comes from the delivered order line, never from the request.
3. The review runs the moderation state machine `SUBMITTED -> AUTO_CHECKED -> PUBLISHED | HELD | REJECTED`. The request returns the resulting state to the author.
4. Published reviews appear on the product page with the first-name initial, the verified-purchase flag and the seller reply when present.
5. Any shopper can ask a question on a product. The question is moderated the same way. The owning store answers (one answer per store and question). The answer is moderated too.
6. Any published item (review, reply, question, answer) can be reported once per user.

## Rules (configurable in `DEFAULT_REVIEW_CONFIG`)
| Rule | Default |
|---|---|
| Verified purchase | A review needs a delivered order line owned by the reviewer (`PurchaseVerificationPort`). Foreign and missing lines both answer 404. |
| Self review | A user who owns or works for the line's store cannot review it (422 `self_review_forbidden`). Checked against `SellerIdentityPort` and the actor's brand grants. |
| One review per order line | Unique `order_line_id`. A second submission is 409 `already_reviewed`. |
| Review window | 180 days from courier confirmed delivery (assumption, VERIFY). |
| Rating | Integer 1 to 5. Body 10 to 2000 characters. Title up to 80. |
| Rewards | Coins are never tied to rating. `reviewRewardIntent()` has no rating parameter, is emitted once per review (flag `reward_intent_at`), and depends only on photo presence and fit info (spec 15.5, 27). |
| Aggregates | Computed from published reviews only. Below 5 published reviews the API returns `summary: null`: no average, no count, no stub. Average is integer tenths, rounded half up. |
| Auto moderation | Toxicity score (AR/EN classifier port) at or above 90 rejects, at or above 50 holds. Image scores likewise. Phone numbers, links and email addresses hold the item. A classifier outage holds the item (fail closed, never publishes). |
| Reports | Only published items can be reported. Own content is 422. Same reporter twice counts once. 3 distinct reporters move a published item to HELD for a human. 20 reports per reporter per day. |
| Edit | The author can edit rating, text, fit and photos. The review returns to SUBMITTED and is re-moderated. The reward intent is not emitted again. |
| Seller reply | One public reply per review by staff of the review's store (roles owner, manager, catalog). Moderated like any text. |
| Q&A SLA | The 48h response clock starts when the question is published. `SweepQaSla` flags a breach once per question (`qa.sla_breached`). The seller list shows `sla_due_at` and `sla_overdue`. |

## State machine
```
SUBMITTED --checks_done--> AUTO_CHECKED --auto_publish--> PUBLISHED
                                        --auto_hold-----> HELD
                                        --auto_reject---> REJECTED
HELD --moderator_publish--> PUBLISHED      HELD --moderator_reject--> REJECTED
PUBLISHED --reported--> HELD               PUBLISHED --moderator_reject--> REJECTED
PUBLISHED | HELD | REJECTED --edited--> SUBMITTED
```
Every transition is a guarded compare-and-set on the stored state, writes a `moderation_log` row (append only) and its outbox events in the same transaction.

## Data
`reviews`, `review_replies`, `questions`, `answers`, `ugc_reports`, `moderation_log` (see migration and `docs/privacy/data_inventory.yaml`). Reviews: PII class P2 (user id, text), seller visibility full for content, none for user id.

## API
| Route | Auth | Idempotent | Rate limit |
|---|---|---|---|
| `POST /v1/orders/lines/{orderLineId}/review` | buyer, owner of the line | required | 20/min/user |
| `GET /v1/me/reviews` | buyer self | no | 120/min |
| `PATCH /v1/me/reviews/{reviewId}` | buyer, author | optional | 20/min |
| `DELETE /v1/me/reviews/{reviewId}` | buyer, author | no | 20/min |
| `GET /v1/products/{productId}/reviews` | public | no | 120/min/ip |
| `GET /v1/products/{productId}/questions` | public | no | 120/min/ip |
| `POST /v1/products/{productId}/questions` | buyer self | required | 10/min |
| `POST /v1/ugc/reports` | buyer self | optional | 10/hour |
| `GET /v1/seller/reviews`, `GET /v1/seller/questions` | seller, store scoped | no | 120/min |
| `POST /v1/seller/reviews/{reviewId}/reply` | seller (`store_product` update), store scoped | required | 30/min |
| `POST /v1/seller/questions/{questionId}/answer` | seller (`store_product` update), store scoped | required | 30/min |
| `GET /v1/admin/moderation/queue` | admin audience, passkey, trust_safety/ops/super_admin | no | 120/min |
| `POST /v1/admin/moderation/{targetType}/{targetId}/decision` | same | required | 60/min |

Lists use keyset cursors on `(timestamp, id)`: newest first for public and author lists, oldest first for the moderation queue.

## Events (outbox, same transaction; ids and enums only, no text)
`review.published`, `review.unpublished`, `review.fit_feedback_submitted` (consumed by sizing), `review.reward_intent` (consumed by rewards), `qa.question_published`, `qa.question_answered`, `qa.sla_breached`, `ugc.reported`, `ugc.moderated`.

## Failure handling
- Toxicity or image classifier down: item is HELD (`classifier_unavailable`); `ProcessModerationBacklog` re-runs items stuck in SUBMITTED or AUTO_CHECKED.
- Concurrent pipeline runs: the compare-and-set makes the loser a no-op, so publish and reward events fire once.
- Outbox relay failures follow the platform relay and DLQ.

## Security and abuse
- AuthZ: policy guard plus RLS. Another user's review is 404, another store's review or question is 404, a shopper on moderation routes is 403 (or 401 on the wrong audience).
- No PII in public payloads: no user id, order line id or staff id; reviewer is the first-name initial or null.
- Abuse: one review per verified line, report volume limit, report-storm hold, self-review block, contact-info hold, rate limits on every write.
- OWASP API: API1 (BOLA) resolvers return the tenant owner, API3 explicit wire serializers, API4 page size 50 and body caps, API6 per-user limits on write flows.

## Metrics
Review rate per delivered line, share of fit-info reviews, held and rejected rate, median time in HELD, reports per 1000 published items, Q&A answer rate within 48h, SLA breach count per store.

## Acceptance
- A seller cannot review its own product; a non-buyer gets 404.
- The reward intent is identical for 1 and 5 stars.
- With fewer than 5 published reviews the summary is null.
- A toxic or flagged item is never public; a classifier outage never publishes.
- Replaying the same order line returns 409 and creates no second review.

## Known gaps and assumptions (VERIFY BEFORE LAUNCH)
- Review window of 180 days and the report threshold of 3 are proposed defaults.
- Policy has no dedicated `store_review` or `review_moderation` resource; reviews and Q&A reuse `store_product` and `admin_console`. A dedicated moderator rule set (trust_safety only, with dual approval for takedown of published items) should replace the in-handler role check.
- Real toxicity (AR/EN) and image classifiers, purchase verification, seller identity, product-store and upload ownership are ports with fakes until the owning modules exist.
- Arabic dialect toxicity quality is unmeasured; build an Egyptian labelled set before trusting the thresholds.
