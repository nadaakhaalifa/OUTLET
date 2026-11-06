# Outlet NK: Master Plan and Problem Book

Date: 2026-11-06. Builds on `docs/outlet-nk-vision-addendum.md` and the three reports in `/reports`.
Durations are estimates for a small team (about 4–6 engineers plus a founder team), not promises.

---

## Part 1: The plan

The work runs in six tracks at the same time. Technology is only one of them.

| Track | Owner |
|---|---|
| T1 Company and legal | Founder + lawyer |
| T2 Brands (supply) | Founder / partnerships |
| T3 Product and technology | CTO + team |
| T4 Operations (delivery, returns, hub) | Ops lead |
| T5 Marketing and community | Marketing lead |
| T6 Money (budget, fundraising) | Founder / finance |

### Stage 0: Prepare (weeks 1–6)

**Decisions (you)**
- Seller plan prices and commission; the Plus price; the default discount display.

**T1 Company and legal**
- Register the company, tax card and VAT.
- Hire an Egyptian lawyer.
- Send the lawyer the verify register: the top 8 items first.
- Start the PDPC licence and appoint a DPO. The deadline has passed, so this is urgent.

**T2 Brands**
- Interview 30 brands and franchise holders.
- Get letters of intent from 15–30 brands.
- Pick a first category: women's and modest fashion plus kids is the suggested wedge.

**T3 Product and technology**
- ADRs 0001–0005 plus new ADRs for web first, seller plans and defect grading.
- Data model, threat models, design tokens, monorepo and CI.

**T4 Operations**
- Request quotes from Bosta and Aramex, including their real COD refusal data.
- Request quotes from 2 payment providers.
- Contact 1 instalment (BNPL) provider.

**T5 Marketing and community**
- Open the WhatsApp Channel and Instagram with a waitlist.
- Brand identity, and the first "Find the defect" (لاقي العيب) videos.

**T6 Money**
- 18-month budget.
- Decide between bootstrapping and raising a seed round.

**Exit gate:** a lawyer's first opinion, 15 or more signed brands, and courier and payment provider quotes in hand.

### Stage 1: Build the foundations (weeks 6–10)
- Accounts and login.
- Consent and privacy centre.
- Ledger, idempotency and outbox.
- Feature flags.
- Seller Center skeleton.
- Admin skeleton.
- Website shell (Arabic first, right-to-left).

### Stage 2: Build the MVP website (weeks 10–24)
- **Shopper:**
  - Village Map and Brand Streets.
  - Product cards with the defect passport.
  - My Size Only feed.
  - Price-proof page.
  - Drop Hour and Outlet Parties.
  - Bag and checkout across many stores (card, wallet, InstaPay, Fawry, COD with risk rules, 1 BNPL).
  - Store bundle discount.
  - Shared family wishlist.
  - Fit-photo reviews.
- **Seller:**
  - KYC.
  - Listing copilot.
  - Defect grading form.
  - Channel guard.
  - Orders and labels.
  - Payouts.
- **Back office:**
  - Returns.
  - Refunds.
  - Reconciliation.
  - ETA e-receipts.
  - DPO console.
- **Trust and checks:** pen test, load test and drop simulation.

### Stage 3: Soft launch (weeks 24–30)
- Invite-only beta: Greater Cairo, waitlist users, 30 brands.
- Measure everything:
  - COD refusal.
  - Returns.
  - Defect disputes.
  - Repeat purchase.
  - Brand second-event rate.
- Fix the problems found, then open to the public with the «عيبه مكتوب» campaign.
- Time the public opening before a big season (Ramadan or back to school), not inside one.

### Stage 4: Grow (months 8–14) — V2
- Android and iOS apps together.
- Live defect walkthroughs.
- Lot Market and partner resellers.
- Try Room pilot.
- Repair Lane and Give Corner.
- Plus subscription.
- Make an Offer.
- Family Bag.
- Hub consolidation.
- Creator program.

### Stage 5: Scale (months 15+) — V3
- Live Auction Hall (if legal).
- AI assistant and try-on (labelled).
- Gam'eya and "get paid now" via partners.
- Exporter passport.
- Governorate expansion.
- GCC.

### Year-1 targets (proposed, check after the beta)

| Metric | Target |
|---|---|
| Listings with a verified or launch-price label | ≥ 70% |
| Brands that run a second event | ≥ 60% |
| COD refusal | ≤ 15% |
| Defect disputes | < 2% of defect orders |
| 90-day repeat purchase | ≥ 25% |
| Contribution margin per order | positive by month 9 after launch |

---

## Part 2: Problems you may face, and how to fix them

Ordered from most dangerous to least. P = how likely, I = how much it would hurt (High / Med / Low).

### A. Brands and stock (the biggest risk)

| # | Problem | P/I | Fix |
|---|---|---|---|
| 1 | **Not enough brands join**, or they send only bad stock | H/H | • Sign brands before building (Stage 0 gate). • Free plan + pay only when you sell. • Offer a channel guard and hidden-brand events so they don't fear damage to their image. • Give a personal launch-partner deal to the first 30. |
| 2 | Brands join once and don't come back | M/H | • Fast payouts. • A sell-through report after every event. • A pre-season outlet commitment. • Track the "second event" rate weekly. |
| 3 | Big brands fear cheapening their name | H/M | • Member-only or hidden display mode. • No search indexing for their pages if they want. • Price floors set by the brand. |
| 4 | Fake or counterfeit goods sold as "export surplus" | M/H | • KYC plus brand authorization or invoices. • "Verified by Outlet NK" checks at the hub. • Image matching across sellers. • Takedown within 48h. • Strong penalties in the Seller Agreement. |
| 5 | Selling export overruns or QIZ stock is illegal or breaks brand contracts | M/H | • Lawyer opinion first (V23). • Start with local brands' own stock, which is the cleanest. |
| 6 | Seller lies about defects | M/M | • Required close-up photos. • AI flags undeclared defects. • A seller accuracy score. • Undisclosed defect = seller pays the return. • Repeat offenders are suspended. |

### B. Money and unit economics

| # | Problem | P/I | Fix |
|---|---|---|---|
| 7 | **High COD refusals** (estimates say 25–35%) | H/H | • Risk score per order. • WhatsApp confirmation. • Prepaid delivery fee after a refusal. • A COD cap for new users. • Open-box at the door. • Push InstaPay and wallets with a small reward. |
| 8 | High returns (fashion is often 25–40%) | H/H | • My Size Only feed and fit-photo reviews. • Exchange first. • Clear defect cards. • Paid change-of-mind returns, free for Plus. • A transparent policy for people who return too much. |
| 9 | Small orders where delivery costs more than the profit | H/M | • Free delivery only above a store threshold. • Store bundles. • Family Bag. • Hub consolidation later. |
| 10 | Customer acquisition is too expensive | M/H | • Organic first: WhatsApp Channel, creators, "Find the defect" videos, brands sharing their own Brand Street links, SEO pages. • Paid ads only after the beta shows repeat buying. |
| 11 | Money runs out before growth | M/H | • 18-month budget. • Stage gates: spend more only when the targets are met. • Raise a seed round after beta data, not before. |
| 12 | Payment provider fees are higher than planned | M/M | • Two providers for competition and failover. • Steer shoppers to InstaPay and wallets. • Negotiate on volume. |
| 13 | EGP devaluation or inflation hurts demand or imported brands | M/M | • This helps an outlet: people trade down. • Prices are set in EGP only. • Focus on local brands. |

### C. Legal and regulation

| # | Problem | P/I | Fix |
|---|---|---|---|
| 14 | **Fake-discount fines** (up to EGP 2m per the Oct 2026 CPA warning) | M/H | • The Price Integrity Engine: no verified evidence = no "% off". • The price-proof page. • A copy lint in the system. |
| 15 | PDPL violation (licence, DPO, consent, breaches) | M/H | • Start the licence now. • Appoint a DPO. • Consent screens. • Breach runbook (72h). • No customer data sent abroad without a licence. |
| 16 | Defect "as is" return rules are unclear | H/M | • Safe default: 14-day returns always apply. • The lawyer confirms V19. |
| 17 | Games, contests, auctions or gam'eya break the law | M/M | • Don't launch them before lawyer approval. • Use partners for anything that holds money. |
| 18 | Store credit counts as e-money | L/H | • Closed-loop only: no top-up, no cash-out. • Lawyer and CBE confirmation. |
| 19 | VAT or e-receipt mistakes | M/M | • The ETA adapter plus daily reconciliation. • A tax adviser. |

### D. Operations

| # | Problem | P/I | Fix |
|---|---|---|---|
| 20 | Courier delays, lost parcels, slow COD remittance | H/M | • Two couriers. • Tracking alerts. • Daily COD reconciliation. • Penalties in the courier contract. |
| 21 | Brands ship late or cancel | M/M | • Accept within 24h, ship within 48h, or auto-cancel. • Health score. • Lower ranking for late sellers. |
| 22 | Customer support overload (in Arabic, on WhatsApp) | H/M | • WhatsApp inbox with macros. • AI-suggested replies that a human sends. • Self-service order tracking and returns. |
| 23 | Disputes over defects after delivery | M/M | • Photo on delivery. • An unboxing video option for expensive items. • Compare against the listing's defect photos. • A human decides within 5 days. |

### E. Product and technology

| # | Problem | P/I | Fix |
|---|---|---|---|
| 24 | Website crashes or oversells during the Drop Hour | M/H | • Row-per-unit stock. • A waiting room. • A 20× load test before launch. • Pre-scale before drops. |
| 25 | Building too many features and launching late | **H/H** | • Build only the MVP list. • The other 30+ features wait for V2/V3. • A strict 24-week MVP deadline; cut scope, never quality. |
| 26 | Security breach or payment fraud | M/H | • PCI SAQ A (we never touch card data). • A pen test before launch. • 3-D Secure. • Fraud rules. • Mandatory passkeys for sellers and admins. |
| 27 | Slow website on cheap Android phones and weak 4G | M/M | • Performance budgets. • Light images (AVIF). • A PWA. • Test on a low-end Android phone. |

### F. Market and competition

| # | Problem | P/I | Fix |
|---|---|---|---|
| 28 | Noon, Amazon or Jumia copy the idea | M/M | They can copy features, not trust or brand relations. • Be first and honest. • Lock brands in with tools (SaaS) and data. |
| 29 | Brands For Less (backed by TJX) enters Egypt | L/H | • Own the local brands and the defect/repair niche, which big off-price chains don't do. |
| 30 | SHEIN or Temu make everything look expensive | M/M | • Sell real brands, verified quality and fast local delivery. • Not the lowest price at any cost. |
| 31 | Customers don't trust a new app | H/M | • Defect passport. • Price proof. • Open-box at the door. • Real reviews. • Bazaar pop-ups to meet people face to face. |
| 32 | Sales are too seasonal (Ramadan/Eid peaks, quiet months) | M/M | • Calendar engine. • Themed parties all year. • Back to school, weddings, summer. |

### G. Team and founder

| # | Problem | P/I | Fix |
|---|---|---|---|
| 33 | Too much work for a small team | H/M | • Hire in order: a partnerships lead (brands), a CTO or lead engineer, an ops lead, then marketing. • Use AI tools, but a human reviews money and security code. |
| 34 | The founder decides everything alone | M/M | • Weekly metrics review. • Advisers in retail, legal and logistics. |

---

## Part 3: Your next 5 actions (this week)
1. Decide D1–D3 (prices, commission, discount display), or tell me to start the ADRs without them.
2. Book an Egyptian lawyer and send them the verify register.
3. List 50 target brands and start interviews (I can write the interview script).
4. Ask Bosta and Aramex for quotes and real COD refusal data.
5. Open the WhatsApp Channel and Instagram waitlist.
