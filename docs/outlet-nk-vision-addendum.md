# Outlet NK — Vision Addendum v1 (the Outlet Village)

Status: **Accepted by the owner (2026-11-06)**: "add them all".
Scope: this addendum **adds to** `docs/haul-master-prompt-v3.md`. Where it conflicts, this addendum wins on product scope and platform order. The master prompt still wins on engineering rules, security, privacy and law (Parts A, B, D, P4).
Evidence and sources: `reports/Outlet NK market and vision.md`, `reports/Outlet NK SaaS and defects.md` and `reports/Outlet NK advanced feature ideas.md`. Figures marked unverified in those reports stay unverified here.

Hard rules that apply to everything below:
- No fake stock, timers, discounts or reviews (CPL 181/2018, A2.13).
- Every number in an ad comes from real system data.
- Items tagged ⚠ go to `docs/compliance/verify-register.md` before launch.

---

## 1. Product changes to the master prompt

| # | Change | Replaces |
|---|---|---|
| C1 | **Web first.** The shopper website (Next.js, PWA, SEO) launches in Phase 1. Android and iOS ship together in Phase 2. | §0 platform order, §P3 (iOS first, web in Phase 3) |
| C2 | **SaaS + marketplace.** Brands use seller plans (free/higher commission → paid/lower commission + tools). Prices and commission are **open owner decisions** (D1). | New module `seller-plans`, separate from shopper Plus |
| C3 | **Defective items are a core category.** A condition-grading module and a defect card for every non-perfect item. | Extends §5, §10, §22 |
| C4 | **Brand-controlled display mode.** A brand may hide "% off" or show it only to members. Unverified discounts are never shown in any mode. | Extends §9.6 |
| C5 | **Daily rhythm.** A fixed Drop Hour every day plus themed Outlet Parties replaces ad-hoc flash sales. | Extends §16 |
| C6 | **B2B lot channel** for resellers and shops. | New module `lots` |

## 2. The concept: one village, eight places

1. **Brand Streets**: each brand has its own storefront on a village map.
2. **Drop Hour**: new stock goes live at the same time every day (after iftar in Ramadan).
3. **Defect Lab**: every flawed item gets a QR defect passport.
4. **Live Auction Hall**: live defect walkthroughs and lot sales ⚠.
5. **Try Room**: pickup points where you try items on and pay only for what you keep.
6. **Repair Lane**: local tailors fix defects ("Fixed by Outlet NK").
7. **Give Corner**: unsold stock goes to charity, and the brand gets a certificate.
8. **B2B Lot Market**: bulk lots for Instagram resellers and governorate shops.

## 3. Defect card and condition grading (C3)

- **Grades:** New with tags · New with imperfections · Sample · Open-box · (later) Pre-owned. Each grade has an Arabic label.
- **Per defect:** type (from a taxonomy) · location · size in cm · severity (minor/major) · a required real close-up photo · a hotspot on the main image.
- **Critical (safety) defects cannot be listed.**
- **Before add-to-bag**, the shopper ticks a separate box: "I have seen the N defects".
- **AI** only flags undeclared defects. It never upgrades a grade.
- **Return rules (safe default ADR, ⚠ counsel):**
  - The 14-day no-reason return still applies to defect items, so "as is" never means "no returns" online.
  - A disclosed and acknowledged defect does not ground a defect return.
  - A defect that was not disclosed, or is worse than shown, is a seller-fault return (30 days, seller pays).
- **Never show AI try-on images without a label**, and never in place of real defect photos.

## 4. Full feature catalogue (all 48 accepted)

Phase: **MVP** = Phase 1 (web) · **V2** = Phase 2 (apps) · **V3** = Phase 3. ⚠ = verify before launch.

**A. Shopper experience**
1. Village Map (MVP)
2. Daily Drop Hour (MVP)
3. Outlet Parties (MVP)
4. My Size Only feed (MVP)
5. Make an Offer, on aged or defect stock only, with a seller floor (V2)
6. Store bundle discount (MVP)
7. Published price ladder (V2)
8. Agent-ready catalog: schema.org markup and a feed (MVP)

**B. Social, community, family**
9. Family Bag with an honest group price (V2)
10. Shared family wishlist (MVP)
11. Fit-photo reviews (MVP)
12. My Haul cards (V2)
13. Creator hosts (V2)
14. Bazaar pop-ups (V2)

**C. Live and auctions**
15. Live defect walkthrough (V2)
16. Live Auction Hall (V3 ⚠)
17. Sealed-bid lots (V2 ⚠)
18. Live clip replays (V2)
19. WhatsApp video "see it first" (MVP)

**D. AI and agents**
20. Defect vision grader (V2)
21. Arabic outlet assistant (V2)
22. Price-drop auto-buy (V3 ⚠)
23. AI preview try-on, labelled (V3)
24. Overstock early warning for brands (V2)
25. Listing copilot (MVP)

**E. Trust and defects**
26. Defect passport, QR per unit (MVP)
27. Verified by Outlet NK (V2)
28. Public price-proof page (MVP)
29. Open-box at the door (V2 ⚠)
30. Hold-until-accepted payment via a licensed partner (V3 ⚠)

**F. Brand and SaaS tools**
31. Brand Street storefront builder (MVP)
32. Channel guard, including hidden-brand events (MVP)
33. Sell-through insights, paid, k ≥ 50 (V2)
34. Pre-season outlet commitment (V2)
35. Get paid now, via a licensed lender (V3 ⚠)

**G. Circularity**
36. Repair Lane (V2)
37. Upcycled drops (V3)
38. Give Corner (V2 ⚠ tax)
39. Outlet passport for exporters (V3)
40. Trade-in for credit, closed-loop only (V3)

**H. Payments and fintech**
41. Instalments from day one (MVP)
42. Eid Saving Goal, no money held (V2)
43. Gam'eya circle via a partner (V3 ⚠)
44. WhatsApp pay links (MVP)

**I. Logistics and pickup**
45. Try Room (V2 pilot)
46. Village hub consolidation (V2)

**J. Egypt culture**
47. Ramadan–Eid calendar engine (MVP)

**K. B2B lots**
48. Lot Market + partner resellers (V2 ⚠ KYC/tax)

**Signature 10 (build order):** 26 → 28 → 2+3 → 4 → 47 → 19+44 → 15 → 48 → 45 → 36+38.

## 5. Marketing and advertising (all accepted)

**Main campaign:** «عيبه مكتوب.. وسعره مكسور» ("The flaw is written, the price is broken").
- Defect close-up billboards: "This missing button saved you X EGP", using a real product and its real price.
- «لاقي العيب» "Find the defect" short-video series.
- Packaging line: "Inspected. Its defect is written on the card."

**Campaigns:**
1. «البلاك فرايداي.. كل يوم الساعة ٩»: Black Friday every day at 9 (after iftar in Ramadan). A clock, never a countdown. In White Friday week: "We don't wait for November."
2. «مقاسك موجود»: "Your size is here".
3. «الخصم ده حقيقي؟ شوف الدليل»: the price-proof page.
4. «ترزي الحتة»: neighbourhood tailor repair videos.
5. «عربية البروفة»: the Try Room truck touring universities and governorates.
6. «وكالة البلح.. أونلاين وبضمان»: online Wekalet El Balah, with guarantees.
7. «شنطة العيلة»: Family Bag, the Eid outfits for the whole family.
8. «جهاز العروسة من الأوتلت»: the bride's trousseau from the outlet.
9. «تحدي تحت الـ٥٠٠»: the "Under 500" creator challenge.
10. «خمن البراند»: hidden-brand events.
11. «عدّاد التوفير»: the real savings meter, from live system data.
12. «اتنقذت من الزبالة»: "Saved from the dump", counting real units only.

**Slogans:**
- «ماركات حقيقية.. خصومات حقيقية.. عيوب مكتوبة» (Real brands. Real discounts. Written defects.)
- «الأوتلت اللي بيقولك الحقيقة» (The outlet that tells you the truth)
- «كل يوم أوكازيون» (Every day is a sale)
- «سعره واطي.. مش ذوقه» (Its price is low, not its style)
- «عيب صغير.. فرق كبير» (Small defect, big difference)

**Ad rules:**
- Real numbers only.
- No fake countdowns or stock.
- Prize competitions need prior approval ⚠.
- Brand names appear in ads only with written permission.
- "First in Egypt" claims only after a fresh competitor check.

## 6. Still open: owner decisions (stop-and-ask items)

| # | Decision |
|---|---|
| D1 | Seller plan prices and commission % (the evidence puts the practical ceiling at about 15%) |
| D2 | Shopper Plus price: keep 200/800 EGP or test 59–99/month and 499–599/year |
| D3 | Default discount display for brands (public % vs member-only vs hidden) |

## 7. New verify-register rows

| # | Item | Owner |
|---|---|---|
| V19 | CPL 181/2018: disclosed defects vs the 30-day defect right; confirm the 30-day period | Legal |
| V20 | CPA fake-discount fine ceiling (EGP 2m per Oct 2026 vs 30k–1m in the spec); competition approval rules | Legal |
| V21 | Legality of shopper auctions and sealed bids | Legal |
| V22 | Gam'eya, escrow and seller cash advances: e-money / FRA status | Legal/Finance |
| V23 | Local sale of export overruns and QIZ stock; brand licence limits; grey imports | Legal |
| V24 | VAT on seller plans and B2B lots; reseller KYC and tax | Tax |
| V25 | Tax treatment of in-kind donations | Tax |
| V26 | Courier COD refusal data; open-box-at-door support | Ops |
