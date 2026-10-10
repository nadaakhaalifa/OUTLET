# Spec 02: Gift cards (closed-loop) and group gifts

Refs: §15.1, §15.2, §B2, ADR-0003, ADR-0014, ADR-0021. Phase 2. **Code-complete behind kill switch `gift_card_sales` (default OFF) and `gift_card_redemption` (default OFF) until VR-03, VR-09, VR-F1-04 are Verified or Accepted risk.**

## Flow
Purchase: design (Birthday, Eid, Ramadan, Wedding, New baby, Graduation, Thank you) -> amount 100-10,000 EGP -> message (text; photo/video moderated, P2) -> delivery channel and schedule -> pay (not store credit, not gift card, not BNPL, not COD) -> issued. Redeem: enter code -> value moves to store-credit `gift_card` sub-balance (ADR-0021 posting) -> spend at checkout. Group gift: organiser creates a pot with target, contributors pay the PSP directly, pot closes -> one card issued; unfunded or failed pot refunds each contributor to their original method. Corporate bulk (B2B portal, CSV, ETA e-invoice) is Phase 2.5 behind separate flag `gift_card_b2b`.

## Rules
- Code: >= 16 chars CSPRNG, Crockford base32, shown once to the purchaser/recipient; stored as HMAC-SHA256 (key in KMS, versioned) + `last4`; lookups by hash only.
- States: `PENDING_PAYMENT -> ISSUED -> DELIVERED -> REDEEMED(partial|full) -> EXPIRED | VOIDED`; group pot: `OPEN -> CLOSED_FUNDED | CLOSED_UNFUNDED -> REFUNDING -> REFUNDED`.
- Redemption converts to store credit; partial use allowed; platform-wide or store-scoped (`scope_store_id`).
- Expiry default 3 years from issue, always shown; extension never silent. Unverified (VR-09).
- Not redeemable for cash; cannot buy gift cards or Plus (laundering loop). Refund of an order paid with gift-card balance returns to the same sub-balance.
- Max 10,000 EGP per card; purchases > 2,000 EGP with a new card require 3-DS; purchase > 5,000 EGP requires purchaser 21+ (§B6).
- Contribution min 50 EGP; pot closes at date or when funded; organiser cannot withdraw.

## Edge cases
Wrong recipient contact -> purchaser can void before DELIVERED (full refund); delivery bounce -> retry then alert purchaser; scheduled send at Cairo time with DST-safe UTC; duplicate redeem race -> row lock on card, second request gets already-redeemed; PSP success but issue failure -> saga compensation refunds; voided card with partial redemption -> only unredeemed remainder voids and forfeits per Legal; moderated media rejection -> card still issues without media.

## Data
| Table | Key columns | PII |
|---|---|---|
| `gift_cards` | id, code_hash, code_hmac_key_version, last4, amount, currency, scope_store_id, status, expires_at, purchaser_id, recipient_contact (enc), design, message (enc), scheduled_at | P2/P3 contact enc |
| `gift_card_redemptions` | id, card_id, user_id, amount, journal_entry_id, ts | P2 |
| `gift_card_attempts` | account_id, device_id, ip_hash, ok, ts | P1 (retain 90d) |
| `gift_pots` | id, organiser_id, target, closes_at, status, card_id | P2 |
| `gift_pot_contributions` | id, pot_id, user_id, amount, payment_intent_id, status | P2 |

## API
| Endpoint | Auth | Idem | Rate limit |
|---|---|---|---|
| `POST /v1/gift-cards` | shopper 18+, attest | yes | 5/h |
| `POST /v1/gift-cards/redeem` | shopper | yes | 5 failed/h/account, 20/day/device |
| `GET /v1/me/gift-cards` | owner (purchased) | no | 60/min |
| `POST /v1/gift-cards/{id}/void` | purchaser, pre-DELIVERED | yes | 10/h |
| `POST /v1/gift-pots`, `POST /v1/gift-pots/{id}/contribute` | shopper | yes | 10/h |
| `GET /v1/shared/gift-pots/{token}` | public token (128-bit, hashed), no PII except nickname | no | 20/min/IP |
| `POST /v1/b2b/gift-cards/bulk` | corporate role | yes | 5/h |

## Events
`gift_card.issued/delivered/redeemed/expired/voided`, `gift_pot.closed`. Analytics `gift_card_purchased`, `gift_card_redeemed`.

## Failure handling
Issue saga: ValidatePurchase -> CreatePaymentIntent -> webhook -> Issue (code, liability posting `gift_card_liability`) -> Deliver. Compensation: refund via PSP. Delivery via provider failover (WhatsApp -> SMS -> email). Expiry sweeper idempotent; posts breakage per Finance policy only after VR-F1-04.

## Security and abuse
Brute-force limits above plus global anomaly alert; constant-time compare on hash; response never differentiates "wrong" from "not found". Card testing screening on purchases; velocity limits; kill switch. Code never logged (logger redaction rule). BOLA on listing.

## Metrics
Gift-card GMV, redemption rate, breakage (reported, never optimised against users), fraud loss < 0.1%.

## Acceptance
```
Given gift_card_sales is off, When POST /v1/gift-cards, Then 503 feature_disabled.
Given 5 wrong codes in an hour, When the 6th attempt, Then 429; the right code still works after the window and all attempts are in audit_log.
Given a 3,000 EGP card on a new card, Then 3-DS is required.
Given a redeemed card, Then store_credit gift_card sub-balance increases by amount and the journal entry balances to zero.
Given a pot that closes unfunded, Then every contribution is refunded to its original method.
Given a gift card in cart, When paying with a gift card, Then rejected (no loop).
```
