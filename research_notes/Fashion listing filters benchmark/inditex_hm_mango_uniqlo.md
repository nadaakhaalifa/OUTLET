# Listing filter UX: H&M, Zara, Pull&Bear, Stradivarius, Bershka, Mango, Uniqlo

Coverage warning: this pass found very little primary evidence. Brand sites (hm.com, mango.com, uniqlo.com UK, uniqlo FAQ) returned 403 or timed out for automated fetches, App Store pages were not readable, and searches returned mostly generic or unrelated material. Everything below is limited to what was actually retrieved. A follow-up needs a real browser or device walkthrough (claude-in-chrome on a mobile viewport, or manual app screenshots) to meet the "design from" objective.

## Entry points on the listing page (category tabs, sticky bar, chips, grid toggle)

### Takeaway
Only Zara has any mobile-app evidence (a Screensdesign flow description); it shows a horizontal filter row above a 2-column grid. Nothing was found for H&M, Pull&Bear, Stradivarius, Bershka, Mango or Uniqlo, and sticky/collapse behaviour is unconfirmed for all brands.

### Cited Findings
- Zara app flow "Browsing and Filtering Products" is described as: top navigation bar, a horizontal filter menu/row, and a two-column product grid; sorting opens as a bottom modal overlay. (Description text of screenshots, so effectively INFERRED from screenshots by the site.) — [Screensdesign](https://screensdesign.com/explore/flows/finding-products/)
- Zara (website, 2016, desktop): filter sits at the top of the page, allows multiple selections, filter button "not the most visible", no sort on filtered results. DOCUMENTED but dated. — [Econsultancy 2016](https://econsultancy.com/eight-examples-of-fashion-ecommerce-product-filters-good-bad/)
- Zara (website, undated older article): described a grid control on the right switching items per page (e.g. 4 up to 24) and said the left menu offered only product types with no colour/price/size filters. Likely outdated. — [Econsultancy](https://econsultancy.com/how-effective-is-zara-s-unique-on-site-search-tool/) (from search snippet only; page not fetched)
- H&M (website, 2016, desktop): filter by colour, size, style with a "clear all" button, called "very user-friendly"; a "Shop by Feature" filter called pointless. DOCUMENTED but 10 years old. — [Econsultancy 2016](https://econsultancy.com/eight-examples-of-fashion-ecommerce-product-filters-good-bad/)

### Inferences
- Zara's app likely uses a horizontal filter row plus bottom-sheet modals per facet (price, sort) rather than one full-screen panel, based on the step descriptions only.

### Gaps
- Grid-density toggles (Zara/Pull&Bear/Bershka 1-2-3 columns, H&M 2/4): no source found for any brand.
- Sticky vs collapsing bar, quick chips, department tabs for all seven brands: not found.
- Pull&Bear, Stradivarius, Bershka, Mango, Uniqlo listing-page entry points: not found. (An Econsultancy piece on Pull&Bear search exists at https://econsultancy.com/pull-bear-s-very-intriguing-search-tool/ but was only seen as a search result, not read.)

## Filter sheet/panel layout, facets, sizes, price, counts, apply wording, sort

### Takeaway
No brand's facet order, size display, price control, live counts or apply-button wording was verified. The only brand-specific facts: Zara's app has a "bottom filter selection grid" with a bottom action bar and a price modal; Uniqlo's size filter was criticised by Baymard.

### Cited Findings
- Zara app steps: a bottom "filter selection grid" with a bottom action bar; a bottom modal for price filtering; a bottom filter overlay menu; sort as a bottom modal. (Screenshot descriptions.) — [Screensdesign](https://screensdesign.com/explore/flows/finding-products/)
- Baymard (usability testing, US-centric, retailer-specific date not stated): Uniqlo's size filter had ambiguous numeric options, one shopper bought jeans with the wrong inseam, another overlooked waist sizes listed below alpha sizes. General finding: group sizes by type under labelled headers; Levi's separate Waist and Length selectors praised. H&M, Zara and Mango are not in the article. — [Baymard](https://baymard.com/research-articles/apparel-how-to-format-size-options-in-the-size-filter)
- Uniqlo app (store stock, not listing filter): per search-result summary of Uniqlo's help centre, store stock is shown in bands ("4 or more" in stock, "2-3" running low, 0 unavailable) with a "show only stores with stock" option; the app also supports barcode scan to check nearby store sizes. I could not fetch the FAQ page (403), so treat as unverified. — [Uniqlo FAQ US](https://faq-us.uniqlo.com/articles/en_US/FAQ/How-can-I-find-out-if-a-particular-item-is-available-in-store) ; [Uniqlo app page](https://www.uniqlo.com/es/en/special-feature/app)
- Generic (not brand): a Nykaa Fashion page listing H&M products shows a retailer-side facet order (Gender, Category, Size, Price, Discount, Curations, Launched In, Color, Fit, Material, Pattern, Occasion...). This is Nykaa's UI, NOT H&M's. — [Nykaa Fashion](https://www.nykaafashion.com/designers/h-m/c/86302?p=17)

### Inferences
- Zara appears to use per-facet bottom sheets with a persistent action bar; whether the action text includes a count is unknown.

### Gaps
- Section order, accordion vs flat, size chips/struck-through OOS sizes, size-system tabs, price slider vs ranges/histogram, multi-select, live counts, "Show N items" wording, applied chips, clear all (apart from H&M web 2016), sustainability tags (Conscious, Join Life), "in stock in my size", store availability facet: not found for H&M, Zara, Pull&Bear, Stradivarius, Bershka, Mango.
- Sort options and sort placement: only "bottom modal" for Zara app; all else not found.

## Empty/no-result recovery, remembered filters, Arabic/RTL

### Takeaway
Nothing found for any brand.

### Cited Findings
- None.

### Inferences
- None made.

### Gaps
- No-result recovery, saved/remembered filters, and Arabic/RTL filter treatment on Egypt/UAE/KSA sites: not found. Arabic sites were not fetched (403 pattern suggests bot blocking; a browser session is needed).

## Engineering/design write-ups (Inditex Tech, H&M Group, Mango, Uniqlo)

### Takeaway
Inditex launched an "Inditex Tech" Medium account in September 2025, but no post on search/filters/facets was found. Nothing found for H&M Group, Mango or Uniqlo.

### Cited Findings
- Inditex launched "Inditex Tech" on Medium (2025) to share technology insights; coverage mentions no search/filter content. — [FashionUnited](https://fashionunited.com/news/business/inditex-launches-inditex-tech-on-medium-to-share-technology-insights/2025090167979)

### Inferences
- A direct browse of the Inditex Tech Medium archive may reveal relevant posts; search did not surface any.

### Gaps
- H&M Group tech blog, Mango tech, Uniqlo/Fast Retailing tech write-ups on facets: not found.
- No Mobbin/Behance/YouTube material was retrieved.
