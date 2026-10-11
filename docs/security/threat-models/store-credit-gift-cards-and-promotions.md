# Threat model: store credit, gift cards, vouchers, referrals and rewards

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §15, §17, §B2, ADR-0003 (Proposed) · Modules: `store-credit`, `gift-cards`, `promotions`, `referrals`, `rewards`

No code exists. Gift-card sales stay behind a kill switch that remains off until legal confirmation (open question 3).

## Scope and assets
Gift card codes (stored as HMAC hash and last 4), store credit sub-balances (derived from postings), voucher codes, referral graph, coins, claw-back records.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| GIFT-S1 | S | Brute-force or enumerate gift card codes | Codes at least 16 chars from a CSPRNG (Crockford base32), HMAC hashed at rest; 5 failed redemptions per hour per account and 20 per day per device, global anomaly alerts; attestation required | GIFT-T01 the 6th wrong code in an hour returns 429 and a correct code still works afterwards; all attempts audited (spec §15.1 acceptance) | planned |
| GIFT-T1 | T | Double redemption or concurrent spend of the same balance | Redemption and spend are ledger entries with idempotency keys; row-level lock on the gift card; balance derived from postings | GIFT-T02 concurrent redemptions of one card never exceed its amount | planned |
| GIFT-T2 | T | Promotion stacking beyond allowed margin | Deterministic engine with explicit stacking matrix; floor price checks | GIFT-T03 fast-check over the stacking matrix (same as PAY-E3) | planned |
| GIFT-R1 | R | Dispute over credit balance | Balance equals sum of postings; nightly projection reconciliation alerts on drift; transactions listed with entry IDs | GIFT-T04 for every user projection equals posting sum (spec §15.2 acceptance) | planned |
| GIFT-I1 | I | Recipient contact details and gift messages leak | Recipient contact field-encrypted (P2), message and media moderated, access limited to purchaser and recipient | GIFT-T05 serializers never expose another party's contact | planned |
| GIFT-D1 | D | Referral and promo farms (self-referral, device farms, stacked accounts) | New phone plus new device plus new payment fingerprint plus 18+, graph clustering, annual cap of 50 rewarded referrals, reward only after return window closes and no refund | GIFT-T06 self-referral on the same device is rejected silently and logged (spec §15.4 acceptance) | planned |
| GIFT-E1 | E | Laundering loops: gift card buys gift cards or Plus, credit turned into cash, P2P transfer | No top-up, no withdrawal, no P2P; gift cards cannot buy gift cards or Plus; credit refunds to original method where required | GIFT-T07 purchase of a gift card using store credit is refused; no code path moves credit between users | planned |
| GIFT-E2 | E | Card-testing through gift-card purchases | 3-DS above 2,000 EGP on new cards, velocity limits, fraud screening on purchases | GIFT-T08 velocity limit blocks repeated small purchases | planned |
| GIFT-E3 | E | Coins or credit retained after a returned order | Claw-back entries on return; negative balance policy decided before launch | GIFT-T09 return of a coin-earning order posts a claw-back entry | planned |

## VERIFY BEFORE LAUNCH
Gift-card expiry limits, VAT point, promotional game rules (register rows 3, 6, 9), and the legal status of store credit (ADR-0003).
