# Seller account management and platform back-office operations

Method note: 8 web searches (search snippets only; WebFetch was not used, so primary pages were not read in full). Confidence is Medium for items cited to official vendor pages, Low for blogs/forums. Many policy pages (Amazon Seller Central, Noon Seller Hub, Zalando CXM targets) are login-gated or were not fetched.

## Seller onboarding, KYC and brand authorization / anti-counterfeit

### Takeaway
Mature platforms gate selling on collected-and-verified trader identity and payout details (legal in the EU via DSA Art. 30; operationally via Stripe's hosted onboarding), and run brand protection as a brand-owner self-service registry plus automated blocking, with immediate takedown and seller notice. Egypt/MENA-specific brand-authorization document rules were not verifiable.

### Cited Findings
- DSA Art. 30 (EU): marketplaces must obtain trader name, address, phone, email, ID document copy, payment account details, trade registry number and a self-certification of legal goods before the trader can sell; small/micro platforms are exempt. Exact "verify" standard not confirmed — [Springlex Art. 30](https://www.springlex.eu/en/packages/dsa/dsa-regulation/article-30/), [Irish CCPC](https://www.ccpc.ie/enforcement-and-regulation/digital/the-digital-services-act)
- Stripe Connect: KYC requirements are per country; Stripe recommends its hosted onboarding; platforms monitor `requirements.currently_due` and `account.updated` webhooks; Stripe may request ID scan or proof of address; risk reviews can add requirements outside the API; new UK/Ireland beneficial-owner rules dated 1 April 2026 — [Stripe identity verification](https://docs.stripe.com/connect/identity-verification), [handle verification updates](https://docs.stripe.com/connect/handle-verification-updates), [upcoming requirements](https://edge-docs.stripe.com/connect/upcoming-requirements-updates)
- Amazon Project Zero: enrolled brands can remove counterfeit listings themselves; each removal notifies linked sellers and feeds automated proactive blocking; Amazon claims 99% of infringing listings are blocked or removed proactively (self-reported, unverified) — [Amazon Project Zero](https://sell.amazon.com/brand-registry/project-zero)
- Project Zero eligibility per a consultant blog: registered trademark, Rights Owner role, >=90% report acceptance over six months, ~99% accuracy expected, misuse monitored (Low confidence) — [Riverbend](https://riverbendconsulting.com/blog/amazon-project-zero/)
- Jumia: replicas and near-identical brand spellings/logos count as counterfeit; sanctions are SKU delisting, fines, shop delisting; counterfeit SKUs removed on detection with email notice; high-risk brands need authentication (Senegal page) — [Jumia counterfeit policy](https://vendor.jumia.com/en/counterfeit-policy/), [Jumia Senegal prohibited products](https://vendorhub.jumia.sn/prohibited-products/)
- Zalando Partner Program is invite-only (no self-signup); onboarding covers contract, zDirect access, logistics choice, assortment plan, mandatory product-safety questionnaire; self-fulfilment requires approved carrier, free shipping, 30-day returns — [Zalando Partner University](https://partner.zalando.com/university/pp/onboard-with-zalando), [requirements](https://partner.zalando.com/university/article/pre-onboarding-and-onboarding-requirements)

### Inferences
- Invite-only (Zalando) vs open KYC funnel (Amazon/Noon/Jumia) is the main trade-off: curation and brand trust vs supply speed. An off-price marketplace that needs brand-owner trust may use a hybrid (curated launch brands, then open with tiered limits).
- Gray-market/parallel-import handling was not found in sources; common practice (authorization letter or purchase invoices, restricted-brand lists) is plausible but unverified here.

### Gaps
- Egyptian/MENA (Noon, Jumia Egypt, Amazon.eg) brand authorization document requirements and parallel-import policy: not found.
- Sanctions-screening and bank-account name-match practice at named marketplaces: not found.
- Egypt counterfeit legislation: one Egypt Independent headline surfaced ([link](https://www.egyptindependent.com/egypts-parliament-adopts-draft-legislation-against-counterfeit-brands/)) but content was not read.

## Scorecards, SLAs, penalty ladders, suspensions and appeals

### Takeaway
Marketplaces use rolling-window rate metrics with published thresholds and an escalating ladder from visibility loss to suspension, with a written plan-of-action appeal. Concrete numbers: Noon cancellation <2.5%, late shipment <3% (7-day windows); Amazon ODR <1%, late shipment <4%.

### Cited Findings
- Noon DirectShip: cancellation rate (seller-rejected or lost before handover / orders with ESD in 7 days) target <2.5%; late shipment rate (handed over after ESD) <3% over 7 days; penalties include stock pulldown, offer deactivation, store suspension or termination; metrics on "Account Health & Performance" tab — [Noon DirectShip performance](https://support.noon.partners/portal/en/kb/articles/directship-seller-performance-management)
- Noon Egypt fee schedule lists a "Retention Penalty Fee" for conduct harming customers (cancelling/delaying/not delivering); amount not shown — [Noon FBP fees Egypt](https://support.noon.partners/portal/en/kb/articles/fulfilled-by-partner-fbp-fees-in-egypt)
- Amazon: ODR <1% and late shipment <4% widely cited; appeals need a plan of action (root cause, steps taken, prevention); late-shipment reinstatements can be fast, ODR slow — blogs/forums only (Low) — [Seller forum](https://sellercentral-europe.amazon.com/seller-forums/discussions/t/f4ca21d4326030d719f4006c1f947554), [SellerLabs](https://www.sellerlabs.com/knowledge-base/how-to-appeal-amazon-suspensions-step-by-step/)
- Zalando uses a Customer Experience Model of country-level KPIs; thresholds are login-gated — [Zalando Partner University](https://partner.zalando.com/university/pp/start)

### Inferences
- The master spec's 24h accept / 48h dispatch SLAs are in line with marketplace norms in structure; Noon-style 7-day rolling rates with a ratio target would suit the spec's Health Score.
- Seller lifecycle states (not sourced): invited/applied, KYC pending, probation/restricted limits, active, watchlist/warned, restricted, suspended, offboarded/terminated; entitlements (listing caps, payout hold period, ad access, badge) typically tier by state.

### Gaps
- Official Amazon Seller Central pages, Etsy policies, Shopify docs not fetched; seller lifecycle tiers and entitlements not sourced.
- Due-process timelines (appeal SLAs) at named marketplaces not found.

## Platform owner back-office, finance ops, trust and safety, staffing

### Takeaway
Credible public benchmarks for owner-side controls and staffing by GMV were not found; only function-level patterns exist.

### Cited Findings
- Marketplaces commonly split fraud (chargebacks, payment) from Trust & Safety (onboarding, compliance, offline risk) — [Ekata](https://ekata.com/blog/unique-challenges-risk-management-marketplace-landscape/)
- T&S Professional Association: no standard org pattern; small platforms have less organizational resilience — [TSPA](https://www.tspa.org/?p=4385)
- Vendor blog (weak, unmethodical): T&S budget 3-8% of GMV at seed, 1-3% mature; 1 moderator per 100k listings; pre-moderate new sellers (<30 days/<5 sales) — [Kolonell](https://kolonell.com/en/blog/marketplace-moderation-tools-2026-en)
- Stripe Connect hosted onboarding offloads much KYC to the processor — [Stripe](https://docs.stripe.com/connect/identity-verification)

### Inferences
- Essential at launch (general practice, unsourced): RBAC, immutable audit log, dual approval for payouts/refunds above threshold, JIT elevation with reason-coded PII access. Later: break-glass drills, SoD automation, model-driven risk queues.

### Gaps
- Dual control, break-glass, reconciliation ops, effective-dated pricing config, support desk tooling, KPIs and dashboards, staffing by GMV stage, seller subscription billing (dunning/proration/B2B e-invoice) and seller education: no reliable sources retrieved in the search budget.

## Comparison with master spec (sections 9.5, 19, 23)

### Takeaway
The spec already covers most patterns; gaps are mainly around lifecycle tiers, appeals timing, brand-authorization for gray-market goods, and seller subscription billing.

### Cited Findings
- Spec 19 KYC states: DRAFT, SUBMITTED, AUTO_CHECKS, APPROVED/NEEDS_INFO/REJECTED, SUSPENDED — [master prompt](/Users/nadakhalifa/OUTLET/docs/haul-master-prompt-v3.md)
- Spec 9.5 ladder: hide % off, auto-correct, badge removal, demotion and 48h auto-pause, 3 violations/90 days loses badge, auto-suspension with human review within 5 business days — same file
- Spec 23: dual approval for payouts, refunds, plan price changes, role grants, exports; JIT elevation; PII view reason codes — same file

### Inferences
- Gaps in the spec: (1) no post-approval lifecycle states (probation/watchlist/restricted/terminated) or tier entitlements; (2) no explicit Noon-style rolling-rate numeric thresholds for cancellation/late dispatch; (3) no written appeal path for non-price penalties, plan-of-action template or reinstatement SLA; (4) no brand-owner registry/self-service takedown beyond a 48h notice-and-takedown line in section 27, and no parallel-import/authenticity-document policy; (5) sellers have commission but no seller subscription plans, dunning or proration specified; (6) break-glass is mentioned only as Super-admin; no staffing or GMV-stage plan; (7) no sanctions-screening vendor or IBAN name-match mechanism named beyond "automatic where APIs exist".

### Gaps
- Findings above rely on search snippets; verify primary pages before use in ADRs.
