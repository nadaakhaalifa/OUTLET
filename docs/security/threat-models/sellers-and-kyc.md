# Threat model: sellers, KYC and Seller Center

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §19, §27, §B1 (sellers as controllers/processors), §9.5 · Modules: `sellers`, KYC, channel integrations, seller team roles, brand takedown portal

No seller code exists. KYC state machine is in the A2.6 list but `packages/domain/src/state-machine/index.ts` is an empty export.

## Scope and assets
KYC documents (commercial register, tax card, signatory national ID, IBAN proof, brand authorization), `channel_connections` OAuth tokens (KMS references), seller staff accounts, buyer delivery data visible to sellers, storefront content, bulk CSV imports, label (AWB) files.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| SELL-S1 | S | Fake seller with forged documents or a stolen identity | OCR and validation, sanctions and watchlist screening where an API exists, IBAN name match to the legal name, brand authorization for third-party brands; unresolved cases go to the Ops queue. Screening providers are not chosen: VERIFY BEFORE LAUNCH | SELL-T01 KYC state machine property test: no path from `SUBMITTED` to `APPROVED` skipping `AUTO_CHECKS` | planned |
| SELL-S2 | S | Seller staff account takeover | Passkey or TOTP mandatory for every seller team member, role scoped, session length limits, device list | SELL-T02 seller session without passkey or TOTP cannot call any Seller Center route | planned |
| SELL-T1 | T | Seller edits price, stock or claims in ways that bypass price integrity | Price changes append to immutable `price_events`; display discounts come only from the VRP; seller cannot type a "was" price shown blindly | SELL-T03 API rejects any request field setting a displayed reference price | planned |
| SELL-T2 | T | Malicious bulk CSV or image upload (formula injection, oversized, polyglot, EXIF GPS) | Dry-run validation, size and row caps, formula-prefix neutralization in exports, upload pipeline: type sniff, size cap, AV scan, EXIF strip, re-encode, private bucket, signed URL up to 15 min | SELL-T04 corpus of hostile CSV and image fixtures is neutralized or rejected | planned |
| SELL-T3 | T | Tampering with KYC status or commission rate | Status changes only through the state machine with audit; commission rate snapshotted per seller order | SELL-T05 direct status update through API is not possible; audit row per transition | planned |
| SELL-R1 | R | Seller denies shipping or rejecting an order, or accepting price terms | SLA timers and state transitions logged with actor; Seller Agreement acceptance versioned with timestamp | SELL-T06 each seller-order transition records actor and request ID | planned |
| SELL-I1 | I | Cross-tenant data access (BOLA/BFLA) | NestJS policy guard plus Postgres RLS on `app.current_store_id`; every Seller Center endpoint has a cross-tenant negative test | SELL-T07 generated test enumerates all `/v1/seller/*` routes from OpenAPI and asserts 404 for foreign IDs | planned |
| SELL-I2 | I | Seller or staff harvests buyer PII | Buyer PII only for active orders, masked where possible, relay phone where the courier supports it, access ends 30 days after delivery or return closure, bulk export of buyer data not offered | SELL-T08 buyer data endpoint omits fields after the window; no export route exists | planned |
| SELL-I3 | I | Channel OAuth token leakage | Tokens stored as KMS references, never returned by APIs, revocation alert to seller | SELL-T09 serializer test: no token field in any response; log scan | planned |
| SELL-D1 | D | Bulk import or channel sync overloads the platform | Per-store quotas, queue with concurrency cap, per-connection rate limits | SELL-T10 oversized import is queued or rejected without affecting checkout latency | planned |
| SELL-E1 | E | Seller staff role escalation (staff to owner, owner to platform admin) | Role changes by owner only with step-up, audit; seller roles are a separate namespace from platform roles | SELL-T11 staff cannot grant roles; seller token on admin route is 403 | planned |
| SELL-E2 | E | Counterfeit or prohibited goods listed | Brand-owner takedown portal with 48 h SLA, pHash duplicate and counterfeit detection across stores, prohibited-items list | SELL-T12 takedown moves listing to hidden within SLA in staging simulation | planned |
| SELL-E3 | E | Automatic suspension is abused by competitors reporting a seller | Report signals are rate-limited and weighted; suspension needs enforcement ladder thresholds; human review of suspensions within 5 business days | SELL-T13 mass reports from new accounts do not trigger suspension | planned |

## VERIFY BEFORE LAUNCH
Legality of fully automatic seller suspension (register row 15); KYC retention (contract plus 5 years is a placeholder); sanctions-screening provider and data residency; Seller Agreement DPA wording.

## Residual risk
Document forgery that passes OCR is a risk accepted until a licensed verification provider is integrated; the Ops queue and payout hold on new sellers reduce loss.
