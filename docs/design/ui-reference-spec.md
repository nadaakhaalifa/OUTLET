# UI Reference Spec v1: the "Outlex" look

Status: **approved by the owner as the target look (2026-11-06): "exactly like that."**
Reference images are in `docs/design/reference/`. Build the screens to match them; this file says how they behave and what must change for legal reasons.
Applies to the shopper web (MVP) and later the apps, and to the Seller Center.

## 0. Global look and feel
- **Style:** a calm, warm "outlet village" built from 3D-rendered mini storefronts and lit wooden/stone shelves. Background is cream/off-white (#F7F4EE-ish). Dark green is the primary colour (#1F3D2B-ish), with a lime accent for focus/hover outlines and discount pills. Small potted plants decorate the scenes.
- **Type:**
  - Headings use a serif ("Discover your next favorite store.", "Big discounts. Unexpected finds.").
  - UI text uses a clean sans (Latin), paired with IBM Plex Sans Arabic for AR.
  - The handwritten script accents ("Great brands. Different stories. Same great prices.") are decoration only and need an Arabic equivalent.
- **Header:**
  - Wordmark top-left, a rounded search bar in the centre ("Search for stores, brands or products…"), then Account and Bag (count).
  - Top tabs: **Explore stores** | **Discover deals**.
  - Category chips: All / Fashion / Electronics / Home / Kitchen / Toys / Pantry.
- **Hover/selected state:** a lime glow outline around the store or product, plus a small tooltip ("Click a store to explore", "Quick view").
- **Motion:** horizontal swipe/drag on every row (owner: "اسحب المنتجات يمين و شمال بشكل سريع"), arrow buttons, dot pagination, and momentum scrolling. Reduce Motion is respected.
- **RTL:** in Arabic everything mirrors. Rows start from the right, the arrows flip, and the "Swipe or drag" hint is translated.

## 1. Store carousel hero (`00-store-carousel-hero.png`)
- Title "Pick a store. Discover a deal." above **one large horizontal carousel of 3D storefronts**: Studio/Wear, reboot., FORMA, PANTRY, MOVE…
- The centre store is enlarged and highlighted. The side stores are smaller and cut off at the edges.
- Each store shows its name and category under it.
- Click → that store's page (§3). Arrows sit left and right; a progress bar plus "Swipe or drag to discover stores ↔" sit below.
- Category chips filter the stores.

## 2. Store directory grid (`01-store-directory-grid.png`)
- "Discover your next favorite store." has **3 rows of 6 storefronts each**. Each row is its own horizontal carousel with arrows and dots.
- Each storefront is a unique 3D illustration in the brand's colours with the brand name on the sign: NOVA, DAILY FINDS, LITTLE JOY, CASA, THREAD, BEAUTY LAB, HOME BOX, URBAN, KITCHEN CO, THE DEAL SHOP, TECH POINT, MINI & ME…
- **How storefronts are made (decision for the build):** a library of 3D storefront templates (by category) that we recolour with the brand palette, with the brand logo placed on the sign. Pro/Enterprise brands can order a custom render. Images are AVIF/WebP, lazy-loaded.

## 3. Store page — shelves + quick view (`03-store-page-shelves-quickview.png`)
- Breadcrumb Stores / El Basha Store and a "← Back to stores" link.
- Store header: logo badge, name, tagline, ★ seller rating (real reviews only), and a **Follow store** button.
- Category chips scoped to the store.
- **Products sit on a lit shelf wall** (3 rows × 6 cubbies). Each cubby has a product image, a small label with name and price, and a green **+** quick-add.
- The shelf slides left and right ("Slide to explore more products", with arrows and dots).
- **Quick-view side panel** (right) opens on click:
  - photo, name, "Sold by", condition chip (e.g. Open box);
  - price with a reference price struck through **only if verified** (see §6);
  - a one-line condition note ("Packaging opened. Tested and fully functional.");
  - colour, quantity stepper, and **Add to bag**;
  - a "Condition & warranty" accordion containing the defect card.

## 4. Discover deals — discount shelves (`02-discover-deals-shelves.png`)
- Hero "Big discounts. Unexpected finds." with a lifestyle image on the right ("Quality finds for a brighter tomorrow").
- Chips run All / Electronics / Fashion / Home / Kitchen / Toys / Pantry, with sort ("Discount: high to low") and a filter ("50% off & more").
- **Shelves are grouped into discount bands, each band one swipeable row:**
  - "70%–60% OFF — The biggest deals, up first."
  - "59%–50% OFF — More great finds to love."
  - "49%–40% OFF — Still amazing value."
- **Product tile:**
  - image on a plinth with a green "-60%" pill;
  - an optional condition tag ("Previous season", "Open box", "Cosmetic mark");
  - name, store name, price, the struck-through reference, and a **+** quick-add;
  - "Quick view" on hover.
- Footer: pagination, "More deals, more discoveries ↗", and "Curated deals from top sellers. New finds added daily."

## 5. Seller Center — Add a product (`05-seller-add-product.png`)
Left nav: Overview, Products, Offers (badge), Orders, Inventory, Store design, Settings, plus a store switcher.

A 4-step wizard: **1 Photos & condition → 2 Product details → 3 Price & stock → 4 Review & publish**, with "Saved as draft" auto-save and Help.

1. **Actual product photos.** Upload or take a photo (JPG/PNG/HEIC, max 10 MB) with slots for Main photo, **Defect close-up** and Packaging & accessories, plus Add video. The hint reads "Use photos of the actual item. Keep defects visible."
2. **Product condition.** Choose one condition (§6). Then fill in:
   - Visible defects (dropdown: e.g. Minor scratch) and Defect location (e.g. Right side panel);
   - a "Does not affect operation" checkbox;
   - Condition notes (500 chars);
   - **Mark defect on photo** (places a hotspot).
3. **Quick details:**
   - product name, with Scan barcode and **Describe by voice**;
   - category, selling price and quantity;
   - warranty (e.g. 6 months — seller warranty);
   - included accessories.
   - The hint reads "Selling several items with different defects? Create a separate listing for each condition."
4. **Buyer offers.** A toggle "Allow buyers to offer a lower price" and a private minimum offer, which is never shown to buyers; offers below it are blocked. The seller can accept, decline or counter.

- **Buyer preview panel** (right, live): exactly what the shopper will see, including the "Make an offer" button.
- **Ready-to-continue checklist:** Actual-item photos added · Defect photo added · Condition described · Price and stock entered.
- Footer: Save draft / Continue to review →.

## 6. Rules the look must follow (legal and product)

| Topic | Rule |
|---|---|
| Discount pills, "% OFF" bands and struck prices | Shown **only when the Price Integrity Engine verified the reference price** (CPL 181/2018; the CPA warned of fines up to EGP 2m in Oct 2026). Items without verified evidence appear in a separate row "Launch price / Great price" with **no** % and no strike-through. Band headers are computed from verified data, never typed. |
| Seller-typed "was" price | The seller can enter a "previous price" as *evidence only*. It is never displayed directly. |
| Condition list | New clearance · Previous season · Open box · Cosmetic defect · Refurbished · **Near expiry (Pantry only)** · Sample. Every non-new item needs a defect or condition photo before publishing. |
| Ratings, "top sellers", counts | Real data only. |
| Brand names in demo images | Real brands (e.g. Philips, Marshall, JBL, Canon) appear only for authorized sellers. Demo and marketing material uses placeholders. |
| "Make an offer" | Must not create a "% off" claim. The final agreed price is just the price. |
| Accessibility | Every storefront and tile has a text label and alt text, keyboard arrows work on carousels, 44-pt touch targets, and contrast of at least AA on cream. |
| Performance | The 3D images are the heaviest part: AVIF, responsive sizes, lazy-loading off-screen rows, blurhash placeholders, and an LCP below 2.5 s on a mid-range Android phone. |

## 7. Changes this design brings to the plan
1. **Multi-category, not fashion-only.** The design covers Electronics, Home, Kitchen, Toys, Beauty and **Pantry (food)** as well as Fashion. Pantry and "Near expiry" add food-safety and labelling rules (⚠ VERIFY: NFSA requirements, expiry display, return exclusions), plus Cosmetics rules for Beauty Lab. Electronics need warranty terms.
2. **Brand name "Outlex"** appears in the design. Proposed working name: Outlex (العنوان/الاسم النهائي = owner decision; check trademark availability in Egypt ⚠).
3. **Exploration is store-first** (village → store → shelf), which matches the Outlet Village concept.
4. **Fit features stay fashion-only:** size, My Size feed and stylist. Electronics and home get warranty and condition instead.

## 8. Build notes
- Components: `StoreCarousel`, `StorefrontCard3D`, `ShelfRow` (virtualised horizontal list), `ProductCubby`, `DealTile`, `DiscountBandRow`, `QuickViewPanel`, `ConditionChip`, `DefectCard`, `SellerProductWizard`, `BuyerPreview`, `ReadinessChecklist`.
- Carousels are built on a scroll-snap list with pointer drag plus buttons. Use a virtualised list once a row has more than 30 items. Respect RTL.
- Design tokens are updated to this palette in `packages/ui-tokens` (Phase 0).
