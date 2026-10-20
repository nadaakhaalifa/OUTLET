# ADR-0037: Creator and affiliate payouts, KYC and tax

- Status: **Proposed, blocked on VR-P3-03 (tax and withholding), VR-P3-04 (disclosure rules), VR-17, VR-22**
- Date: 2026-10-12
- Deciders: Finance, Legal, Tax, Product
- Spec refs: §15.4, §B4, §T4, ADR-0008, ADR-0021, docs/specs/phase-3/creators-affiliates.md

## Context and problem statement
Creators earn commission on attributed sales and must be paid. Payouts to individuals raise KYC, tax form, VAT-registration threshold (cited as EGP 500k in the spec, unverified), withholding and payment-licensing questions. Commission can only be earned on goods that survive the return window.

## Considered options
1. **Accrue-only plus manual finance payout (default).** Commission accrues in the ledger as `creator_payable:{creator}` after the return window; payout runs only for creators with completed KYC, through the existing payout rail, by dual approval. No in-app instant withdrawal.
2. **Automated weekly payouts via the seller payout rail** with creators modeled as lightweight sellers.
3. **Pay in store credit only** (closed-loop), avoiding cash payout.

## Decision (proposed default)
Option 1 with the domain built so option 2 is a configuration change. Option 3 is offered as a creator choice because it avoids payout licensing, but it is not the default since commissions are typically expected in cash. Creators are 21+ with KYC (§B6), signed terms, tax identity captured as P3 field-encrypted data. No payout is enabled until VR-P3-03 is Verified. Commission is computed on net-of-refund, post-return-window merchandise value, never on shipping, VAT or voucher-funded value. Platform-funded commission is a ledger expense with its own VAT base question (VR-P3-03).

## Consequences
Good: no payout licensing exposure by default; creator money is on the ledger from day one. Bad: slow cash-out; Finance manual load until automated.

## Owner decision required
Commission rates and caps (pricing decision); cash payout vs store-credit-only for creators; who signs creator terms.

## Safe default if no answer
Accrue only; payouts off; creators see accruals and can opt into store credit.

## Implementation status (2026-10-12, wave B backend)
Status stays **Proposed**. The default (option 1, accrue only, payouts off) is implemented and tested on synthetic data: accrual after return-window closure, pro rata clawback with explicit negative balances, silent fraud voids, dual-approval payout path on the existing payout machine, `kill.creator_payouts` blocked and the payout provider Unconfigured by default. Nothing in this change moves money. Needs the Fable ledger checkpoint (new ledger accounts `creator_payable`, `creator_commission_expense`, migration 0074 chart extension, pinned chart tests updated) before any enablement. Open owner items unchanged: rates and caps, cash versus credit, who signs terms, VR-P3-03 and VR-P3-04.

## Chief reviewer findings, part A (2026-10-12): fixes and notes
Fixed in code (migration 0078, creators module, registry jobs); the module stays `blocked` in production bindings and payouts stay off.
- **A-1 click ingest.** Device and IP hashes are HMAC with a server-held salt (`clickSalt`, required in production), IPv6 collapses to /64, caps are keyed on the identifiers actually used (per creator and IP, per device hash, per link, per hour), the same device on the same link inside 60 s stores nothing, and the outbox gets at most one `affiliate.clicks_active` per creator per minute. A click for another creator inside 24 h after the buyer's first-party session start cannot displace an earlier valid click. **Residual risk, owner and mobile decision:** a device id is client supplied, so anyone who knows a buyer's id can still post a click that hashes to the buyer's stored hash. Closing it needs App Attest / Play Integrity or a server-issued signed install token on the click route; until then the caps, dedupe, protected window and fraud gate are mitigations, not a fix. Commissions should not be enabled for cash before that decision.
- **A-2 payout send.** The APPROVED to SENT compare-and-set is the claim; the ledger entry is posted only by the winner. `recoverOrphans` (job `creators.payouts-recover-orphans`) re-posts and re-sends a SENT payout that lost its post, and reverses any entry whose payout is not SENT or SETTLED.
- **A-3 fail closed.** A missing creator identity profile (or a failing referral lookup) stores the attribution as HELD: nothing accrues, the line-closed message is not consumed, and the next attribution call re-evaluates. `VoidAttribution` voids an attribution and plans a full clawback of every commission of the order group in one transaction (negative payable stays explicit).
- **A-4 owner decision recorded (safest default, no stacking).** An order that carries a referral reward earns no creator commission: the attribution is voided silently with reason `referral_stacking`. This is deliberately the opposite of the spec's earlier "creator wins" sentence because the referral program is live and funded, the creator program is dark, and the safe direction for platform money is to pay one reward per order. The owner may reverse it (creator wins) only together with a change in the referrals module.
- **A-5 to A-10.** Held release uses the accrual's conditional upsert and an over-cap commission raises `creator.commission_over_cap`; approving out of ON_HOLD re-checks the cause; the accepted terms text is stored insert-or-verify and an account row needs it; guard triggers make postings and commissions immutable as documented; the application list is trust and safety only and approval needs review evidence in `reason`; jobs for the accrual sweep, claim-then-post repair, payout orphan recovery and click partition maintenance with the 13 month purge are registered.
