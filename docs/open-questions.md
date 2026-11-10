# Open questions (Phase 0, max 12)

Date: 2026-11-07. Source: `docs/BUILD-PROMPT.md` §10.1, `docs/plan-and-risks.md`, `reports/Outlet NK end to end build plan.md` (open questions Q1–Q10), `docs/outlet-nk-vision-addendum.md` §6.

Only questions that block an **irreversible or legally binding** decision are listed. Everything else gets a safe default and an ADR. Each question is also a card in the Build Tracker ("Your decisions"), where the owner answers it.

| # | Question | Options (recommendation in **bold**) | Blocks | Latest safe date | Who answers | Tracker |
|---|---|---|---|---|---|---|
| Q1 | Where do we host personal and money data? (ADR-0002) | **A. Hybrid: personal and money data in Egypt (Huawei Cloud Cairo, after a 1-week test); public catalog and images on the global edge.** B. AWS UAE (me-central-1) plus a PDPC transfer licence. C. Everything in Egypt. | All infrastructure, IaC, environments | Week 4 (residency spike) | Owner + counsel (V2, V37–V39) | D4 |
| Q2 | How is one multi-store payment split between sellers? | A. PSP marketplace split (connected or sub-merchant accounts). B. We collect as merchant and pay sellers from settled funds (may need a licence). **C. Ask Paymob and Kashier in writing, get counsel's view, then decide.** | Checkout saga, payouts, ledger accounts, ADR-0003 | Week 8 | PSPs + counsel (V3, V4) | D5 |
| Q3 | Seller plan prices and commission % (D1) | A. Free plan with higher commission and a paid plan with lower commission. B. One commission, no plans. **C. Decide after 15 brand interviews, with about 15% as the ceiling.** | `seller-plans` module, Seller Agreement | Week 6 | Owner | D1 |
| Q4 | Shopper Plus price (D2) | A. 200/800 EGP. B. Test 59–99/month and 499–599/year. **C. Decide after beta data (not needed for the web MVP).** | Phase 2 plan | Phase 2 | Owner | D2 |
| Q5 | Default discount display for brands (D3) | **A. Public verified % by default; a brand may switch to member-only or hidden.** B. Member-only by default. C. Hidden by default. | Price block, Brand Street, SEO markup | Week 6 | Owner | D3 |
| Q6 | Is "Outlex" the brand name? | **A. Keep it as the working name and run a trademark search now (EG, KSA, UAE, Morocco).** B. Choose a new name before launch. | Domain, SEO paths, identity, marketing | Week 4 | Owner + counsel (V31) | D7 |
| Q7 | Which categories do we launch with? | **A. Women's and modest fashion plus kids.** B. All fashion. C. Multi-category. | Catalog taxonomy, attribute sets, brand sign-up | Week 6 | Owner | D6 |
| Q8 | Do disclosed defects still allow returns, and is the 30-day defect window right? | Safe default: the 14-day no-reason return always applies, and a disclosed defect is not a return reason. Counsel confirms. | Returns policy, defect card, Seller Agreement | Week 11 | Counsel (V19) | — |
| Q9 | Is the age to buy 18 or 21? | **A. 18 to shop; 21 for contracts (Plus, seller signatory, payouts) until counsel confirms.** B. 21 for everything. | Onboarding gates | Week 5 | Counsel (V8) | — |
| Q10 | When must we issue ETA e-receipts, and can we sign for sellers? | No default possible; this sets the tax engine scope. | Tax engine, seller onboarding | Week 18 | Tax adviser (V6) | — |
| Q11 | Is closed-loop store credit (no top-up, no cash-out) outside e-money rules? | Safe default per ADR-0003: closed-loop only; a licensed partner for anything else. | Wallet, refunds to credit, gift cards | Week 14 | Counsel / CBE (V3) | — |
| Q12 | What do we do with the older code on branch `feat/phase-0-foundations`? | **A. Keep it as a reference; port reviewed parts (ledger, inventory, idempotency) into the new repo with fresh tests and two-key review.** B. Build on top of it. C. Ignore it. | Phase 0b engineering | Before Phase 0b | Owner | D0 |

## Not questions (handled by default)
- Funding path and a holding company abroad are business decisions, tracked as D9 and task F-02 in the Build Tracker. They do not block Phase 0 documents.
- AI training bots in `robots.txt`: default is to allow search bots and block training bots until the owner decides (D8).

## Numbering note
The source documents reuse verify-register numbers: `V27`–`V29` are used for different items in `docs/specs/price-watch.md`, `docs/adr/0006-global-ready-from-day-one.md` and the build-plan report. The verify register (task P0-12) gives each item one number: V27–V28 Price Watch, V29–V31 ADR-0006, V32–V36 shipping spec, and V37–V39 for the build-plan report's infrastructure items. The build plan's other items (old V30–V42) are now V40–V52. All source files were updated on 2026-11-07 and now agree with `docs/compliance/verify-register.md`.
D7 (2026-11-08): the owner chose the brand name **Outlex** (replaces the working name Outlex). Trademark search (V31) must use Outlex.
