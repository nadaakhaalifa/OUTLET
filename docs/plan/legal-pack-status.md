# Legal pack status (drafts for Egyptian counsel)

Status of every document: **DRAFT, not reviewed by counsel, not in force.** Location: `docs/legal/`. Each document exists as `<name>.ar.md` (authoritative) and `<name>.en.md` with the same clause numbering. Every uncertain point carries a visible `VERIFY WITH COUNSEL: <row>` note; row ids refer to `docs/compliance/verify-register.md`. No company names, registration numbers or addresses were invented: all are `[PLACEHOLDER: ...]`.

Date of drafts: 2026-10-11. Nothing here is legal advice. Arabic text was drafted by an AI model and needs review by a qualified Arabic legal translator/lawyer before use.

| Document (file stem) | Blocking register rows | What counsel must decide |
|---|---|---|
| Terms of Service (`terms-of-service`) | VR-07, VR-08, VR-05, VR-22, VR-03, VR-01 | Joint liability of the platform; age of majority and contracts with 18-20 year olds; liability exclusions; forum and governing law; licence to display user content; whether collecting for sellers needs a licence |
| Privacy Policy (`privacy-policy`) | VR-01, VR-02, VR-08, VR-B4-07 | Lawful basis for non-consent processing; controller and DPO details and PDPC licence; cross-border statement (ADR-0002 slot); DSAR deadline (30 days assumed); retention periods marked VERIFY; breach clocks (72h/3 days) |
| Consent texts (`consent-texts`) | VR-01, VR-02 | Whether wording meets "explicit, informed, specific, freely given"; whether error monitoring without identifiers needs consent; `cross_border_ml` wording once the transfer route is chosen |
| Store Credit Terms (`store-credit-terms`) | VR-03, VR-09, VR-07, VR-B4-04, VR-F1-04 | Written opinion that closed-loop credit is outside e-money (CBE Law 194/2020); lawful expiry per sub-balance; forfeiture on account deletion; VAT on coins and credit |
| Gift Card Terms (`gift-card-terms`) | VR-03, VR-09, VR-F1-04, VR-B4-04, VR-06, VR-08, VR-07 | Whether sale may start at all (kill switch off); expiry limits; VAT point; age 21 above 5,000 EGP; non-refundability after redemption |
| Plus Subscription Terms (`plus-subscription-terms`) | VR-08, VR-04, VR-07, VR-10, VR-23, VR-06, VR-B4-01 | Plus age 21 vs 18; PSP recurring support; pro-rata refund duty for subscriptions; App Store route (Plan A or B); auto-renew disclosure sufficiency |
| Returns and Refunds Policy (`returns-refunds-policy`) | VR-07, VR-04, VR-F1-02 | Statutory day counts and start date (delivery vs receipt, ADR-0009); how 7-day cancellation and 14-day return combine; exclusions list; delivery-fee refund; deadline for COD cash refunds; BNPL provider refunds |
| Rewards and Referral Terms (`rewards-referral-terms`) | VR-09, VR-B4-04, VR-17 | Legality of spin/scratch games and mystery boxes under promotional and lottery rules; coin expiry; creator payout tax and VAT; referral rewards as taxable benefit |
| Seller Agreement (`seller-agreement`) | VR-07, VR-15, VR-13, VR-01, VR-22, VR-03, VR-04, VR-PO-01, VR-06, VR-B4-01, VR-B4-02, VR-F1-05, VR-F1-06, VR-08 | Enforceability of automatic penalties and commission surcharge; automatic suspension with human review in 5 business days; monitoring consent and crawler legality; payout holds; indemnity and caps; delegated e-receipt signing; fee bearing |
| Seller DPA annex (`seller-dpa-annex`) | VR-01, VR-02 | Seller role (processor or independent controller); breach-notice window; sub-processors; relay phone numbers |
| Prohibited Items (`prohibited-items`) | VR-07, VR-15 | Complete list of Egyptian prohibited and licensed goods; handling of pre-loved goods |
| Review Guidelines (`review-guidelines`) | VR-09 | Rules on incentivised reviews and disclosure; moderation and removal appeal |
| IP Notice-and-Takedown (`ip-takedown-procedure`) | VR-07, VR-15, VR-01 | Safe-harbour style position for marketplaces in Egypt; counter-notice timing; sharing notifier identity |
| Accessibility Statement (`accessibility-statement`) | VR-07 | Whether a statement is legally required; do not publish conformance claims without audit |
| Cookie and Tracking Notice (`cookie-tracking-notice`) | VR-01, VR-02 | Which technologies are strictly necessary; consent per category; SDK inventory |

## Cross-cutting items not covered by the pack
- A Subscription refund policy for Family and Student plans (Phase 3) and creator/affiliate agreement are not drafted.
- Courier, PSP, BNPL and SMS/WhatsApp contracts and their DPAs (processors register) are not drafted here.
- Corporate gift-card B2B terms are not drafted.
- Every document needs a version id, an effective date and a consent-record linkage before use (`consent_records.version`).

## Gating rules
1. No document is published, and no real personal data is processed, while VR-01 and VR-02 stay open and ADR-0002 is not accepted.
2. Gift-card sale and redemption stay behind the kill switch until VR-03 and VR-06 are verified or accepted in writing.
3. Plus stays off for users aged 18-20 until VR-08 is answered.
4. Arabic is authoritative; an English change must not ship without the Arabic change (CI already fails on missing AR keys for app strings; extend to these files).
