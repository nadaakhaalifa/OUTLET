# ADR-0009: Condition grading, defect card and QR defect passport

- Status: **Proposed — owner accepted recommendation 2026-11-07; needs counsel/contract confirmation before anything real** (depends on D6 and the age rule; the return rule is a safe default waiting for counsel, V19)
- Date: 2026-11-07
- Deciders: Owner, Product, counsel, CTO
- Sources: `docs/outlet-nk-vision-addendum.md` C3, §3, features 20, 26, 27; `docs/design/ui-reference-spec.md` §3, §5, §6; `reports/Outlet NK SaaS and defects.md` ("The defect card is the product…"); `research_notes/Outlet NK SaaS and defects/defects_grading.md`; `reports/Outlet NK advanced feature ideas.md` (Defect Lab, feature 26); `docs/BUILD-PROMPT.md` §5 (`itemCondition`), §6; master prompt §5, §22

## Context

- Defective items are a **core category** (addendum C3). Every non-perfect item needs a **defect card**, and every unit a **QR defect passport** (feature 26, MVP).
- Platforms that sell imperfect goods use **two axes**: a short condition grade and a list of specific flaws (eBay "New with imperfections" for clothing since Jan 2025; Back Market grades; Vinted "choose the lower condition when unsure"). Severity can follow AQL: Critical / Major / Minor (V-Trust). Our taxonomy is our own design built from these sources, not a published standard.
- **The sources use different grade lists** (see "Reconciling the grade lists" below).
- Law: Law 181/2018 is reported to give a **14-day no-reason return**; the 30-day defect period was **not verified** against the final law; no source confirmed whether a **disclosed** defect removes the defect-return right (V19).
- AI defect detection accuracy varies widely (one 2024 study: 74% for VGG-16), and lab data uses flat fabric, not garment photos. So AI can assist, not grade.

## Options considered

| Option | Good | Bad |
|---|---|---|
| A. One combined scale (e.g. A/B/C) | Simple badge | Hides what is actually wrong; disputes are hard to judge; no structured filters |
| B. Free-text condition notes only | Fast for sellers | Not comparable, not filterable, weak evidence in disputes |
| **C. Two axes: closed condition grade + structured defect rows, with a per-unit passport (chosen)** | Matches eBay/Back Market practice; filterable ("no stains", "only minor"); strong dispute evidence; maps to schema.org | More seller input; needs a good wizard |

**Choice (2–3 lines):** C gives shoppers exact facts and gives us evidence for disputes, which is the product's trust promise ("the flaw is written"). The 4-step seller wizard and AI hotspot suggestions keep the extra input manageable.

## Decision

### Reconciling the grade lists
| Source | List |
|---|---|
| Vision addendum §3 | New with tags · New with imperfections · Sample · Open-box · (later) Pre-owned |
| UI spec §6 | New clearance · Previous season · Open box · Cosmetic defect · Refurbished · Near expiry (Pantry) · Sample |
| Advanced feature ideas (Defect Lab) | Hub grades A/B/C |

Resolution (addendum wins on scope; the UI labels are kept as display tags):
- **Condition grade** (one per unit, closed enum): `new_with_tags`, `new_with_imperfections`, `sample`, `open_box` (includes customer returns), `refurbished` (electronics; not at launch), `pre_owned` (later). Each has an Arabic label and a one-line definition.
- **Stock reason** (separate tag, optional, no effect on returns): `previous_season`, `overstock`, `end_of_line`, `customer_return`, `near_expiry` (Pantry only; not at launch, ⚠ V56). The UI's "New clearance" and "Previous season" = `new_with_tags` + a stock reason. The UI's "Cosmetic defect" = `new_with_imperfections`.
- **Defect Lab A/B/C** is not a third scale. Hub inspection records `inspected_by = hub` and may change the grade **down only**.
- Launch categories are fashion (D6), so `refurbished` and `near_expiry` stay disabled by config until their categories launch.

### Defect rows
- Per defect: `type` (taxonomy: stain/discoloration, hole/tear, missing or damaged button/trim, broken zip/hardware, open seam/stitching flaw, pilling, fading, print misalignment, wrong size tag, odour, packaging damage; extendable per category), `location` (from a per-category list, e.g. "left cuff"), `size_cm`, `severity minor|major`, **one required real close-up photo**, a hotspot `(x, y)` on the main image, `affects_function bool`.
- **Critical (safety) defects cannot be listed.** The listing is blocked. Examples for the kids category at launch: drawstrings on children's clothes, loose small parts (V-Trust example; Egyptian product-safety rules ⚠ V69).
- Photos of defects are **never AI-edited or AI-generated**. AI try-on images are always labelled and never replace defect photos.
- Seller must upload one full-item photo plus one close-up per defect. pHash checks catch reused or stock photos.
- When unsure, the seller picks the lower grade (wizard hint, Vinted practice).

### Data (indicative; the ERD is authoritative)
- **Name mapping to `docs/data-model.md`:** `condition_reports` = `defect_cards`, `defects` = `defect_items`, `defect_passports` = `item_units`, `defect_acknowledgements` = the `defect_ack_*` columns on cart and order lines. The ERD names win.
- `condition_reports(id, sku_id, unit_id NULL, grade, stock_reason NULL, notes_ar, notes_en, version, created_by, inspected_by seller|hub, created_at)`: immutable versions.
- `defects(id, condition_report_id, type, location, size_mm, severity, affects_function, photo_id, hotspot_x, hotspot_y)`. Sizes are stored in **mm as integers**, shown in cm.
- `defect_passports(id, unit_id, public_code, current_report_version, content_hash, status active|sold|withdrawn, created_at)`.
- `defect_acknowledgements(id, user_id, unit_id, report_version, defect_count, acknowledged_at, order_line_id NULL)`: P2.
- All listing-side tables are P0 (public). Acknowledgements are P2 (private plane, ADR-0002).

### QR defect passport
- One passport per **unit** with a non-guessable `public_code` (≥ 128 bits from a CSPRNG). QR → public page `/{market}-{locale}/passport/{public_code}` (P0, cacheable, no buyer data ever).
- Shows: grade and definition, every defect with photo and hotspot, stock reason, inspection history (who inspected and when), and later repair history (Repair Lane, V2) and "Verified by Outlex" (V2).
- **Versioned and tamper-evident:** each change creates a new report version; the passport stores a hash of the current content. The order line stores the version the buyer acknowledged, so a later edit cannot rewrite what was sold.
- After sale the passport stays reachable (status `sold`), so resale and gifting keep the proof. The product page itself follows the sold one-off rule (410 or 301, ADR-0005).
- The QR label is printed by the seller from Seller Center, or by the hub for hub-inspected items.

### Shopper flow
- Defect card on the product page and quick view: grade badge, defect count, each defect with icon, Arabic label, location, size and photo; pins on the main image.
- **Before add-to-bag**, a separate, **never pre-ticked** box: "I have seen the N defects". It is recorded with the report version. Without it, add-to-bag is disabled.
- A "compare with the perfect item" price ("X EGP vs Y EGP new") appears **only** when Price Watch verified the perfect item's price; otherwise plain price.
- Filters: by grade, by severity ("only minor"), by defect type ("no stains").

### Returns: safe default until counsel answers V19
1. The **14-day no-reason return applies to defect items too**, counted from `delivered_at`. "As is" never means "no returns" online.
2. A defect that was **disclosed and acknowledged** is not a ground for a defect return.
3. A defect that was **not disclosed, or is worse than shown**, is a **seller-fault return**: 30-day window (V7/V19), seller pays return shipping, the seller's grade-accuracy score drops.
4. Statutory exclusions (hygiene items, personalised goods) follow master prompt §22 and stay ⚠ V7.
5. Disputes are judged against the passport version acknowledged, the courier's delivery photo and an optional unboxing video; a human decides within 5 business days.

### AI
- AI **only flags** possible undeclared defects and suggests hotspots. It **never upgrades** a grade and never sets a grade on its own (addendum §3). The defect vision grader is V2 (feature 20).

### Structured data (BUILD-PROMPT §5)
Conservative mapping; never claim "new" for an item that is not:
| Our grade | schema.org `itemCondition` |
|---|---|
| `new_with_tags` (no defects) | `NewCondition` |
| `new_with_imperfections` | `DamagedCondition` |
| `sample` | `UsedCondition` |
| `open_box` | `UsedCondition` |
| `refurbished` | `RefurbishedCondition` |
| `pre_owned` | `UsedCondition` |
Any listing with at least one declared defect maps to `DamagedCondition`. The SEO lead confirms this against Google Merchant condition rules before launch.

## Consequences

**Good**
- Exact, comparable facts for shoppers; strong evidence in disputes; a clear marketing story («عيبه مكتوب»).
- Grade accuracy becomes a seller metric that feeds the Seller Health and Price Trust scores.

**Bad / risks**
- More seller work per listing, especially for one-off units. Mitigation: wizard, voice input, AI hotspot suggestions.
- If counsel finds that disclosed defects **do** still allow defect returns, rule 2 changes and return costs rise for defect stock.
- Grade disputes will happen (Back Market needs a dedicated flow); we need the same.

## Verify-register rows
- **V7** CPL 181/2018: refund deadline, 7-day vs 14-day interplay, statutory exclusions
- **V19** disclosed defects vs the defect-return right; confirm the 30-day period
- **V20** CPA fake-discount fines (relevant to the "compare with perfect" price)
- **V56** Pantry and near-expiry (NFSA), cosmetics, electronics warranty, before those categories launch
- **V69 (new)** Egyptian product-safety rules for kids' clothing and accessories (e.g. drawstrings, small parts), a launch category (D6)

## Related
ADR-0005 (one-off units), ADR-0007 (SEO), ADR-0008 (display modes), `docs/specs/price-watch.md`, `docs/design/ui-reference-spec.md`.
