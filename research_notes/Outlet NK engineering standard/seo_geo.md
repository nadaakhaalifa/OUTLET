# SEO and GEO for Outlet NK (multi-vendor AR/EN marketplace, Next.js App Router), as of 2026-11-07

Method note: developers.google.com could not be reached from this session (DNS blocked), so Google Search Central rules marked **[GSC-memory]** come from the researcher's prior knowledge of those docs (up to mid-2026). They are not re-fetched and must be re-checked against the live docs. Everything else is cited. Secondary SEO blogs are flagged.

## 1. Technical SEO for large catalogs (crawl budget, facets, pagination, sitemaps, OOS, hreflang, rendering, CWV)

### Takeaway
Index only canonical product pages, store pages and a curated, whitelisted set of category+facet combinations. Keep every other facet crawl-blocked. Use plain `?page=N` links with self-canonicals and sharded sitemaps. Render every indexable page on the server (SSR/ISR). Keep out-of-stock pages at 200 while they can restock, and 404/410 or redirect dead ones.

### Cited Findings
- Dec 2024 "Crawling December" (Gary Illyes): faceted navigation is "the number one" cause of crawl issues. Prevent facet URLs from being crawled when you don't need them indexed. Google turned this into an official faceted-navigation doc — [Userp summary (secondary)](https://userp.io/news/google-makes-old-faceted-navigation-doc-new-official-guidelines/).
- Google (Mueller, ~2020–21): an OOS product page may be treated as a soft 404, depending on how much value it offers beyond the product. For one-of-a-kind products that are gone, archive or remove the page — [SE Roundtable](https://www.seroundtable.com/google-timeframe-out-of-stock-product-soft-404-30777.html), [SE Roundtable (one-of-a-kind)](https://www.seroundtable.com/google-out-of-stock-one-of-a-kind-products-30362.html), [SEJ](https://www.searchenginejournal.com/google-out-of-stock-products-may-impact-search-visibility/444500/).
- **[GSC-memory]** Google's pagination doc: give each page a unique URL (`?page=2`), link pages with real `<a href>`, and do **not** canonicalize page 2+ to page 1 (self-canonical instead). Google has not used rel=next/prev for indexing since 2019. Infinite scroll needs paginated URL fallbacks.
- **[GSC-memory]** Faceted-nav doc: block unneeded facet URLs via robots.txt `Disallow` (preferred to save crawl), or use URL fragments. Return 404 for empty or nonsense facet combinations. Keep a consistent parameter order. `rel=canonical` and `noindex` do not save crawl budget, because the page must still be fetched.
- **[GSC-memory]** Sitemaps: max 50,000 URLs or 50 MB uncompressed per file, and a sitemap index of up to 50,000 sitemaps. `lastmod` is used only if it is consistently accurate. `priority` and `changefreq` are ignored.
- **[GSC-memory]** hreflang: bidirectional (return links required), plus a self-reference. Use language-region codes like `ar-EG` and `en-EG`, plus `x-default`. Declare it in HTML `<link>`, HTTP headers or the sitemap. Google does not use the `lang` attribute or `dir` for targeting. Google says to avoid IP or locale auto-redirects.
- **[GSC-memory]** Rendering: Google renders JS, but rendering is deferred and costly. Google recommends server-side rendering, static rendering or hydration. Core Web Vitals (LCP ≤ 2.5 s, INP ≤ 200 ms (INP replaced FID in March 2024), CLS ≤ 0.1, all at p75) feed the page-experience signals, which Google describes as minor relative to relevance.

### Inferences (proposed rules for Outlet NK)
- **URL scheme:** `/eg-ar/…`, `/eg-en/…`, and later `/sa-ar/…`. Each locale page carries an hreflang cluster: `ar-EG`, `en-EG`, later `ar-SA`, plus `x-default` → a country/language chooser or `/eg-ar/`. Only cluster pages where the same product is actually sold in that country. Set `<html lang="ar-EG" dir="rtl">`, which is for users and accessibility, not ranking. Do not geo-redirect Googlebot; show a banner instead.
- **Facets:** use an allow-list (e.g. category × {brand, gender, condition-grade, size-group, Local/Global}, depth ≤ 1–2) that has search demand and ≥ N products. These get clean path URLs, self-canonicals, are listed in sitemaps and have unique AR/EN titles. Every other filter (price range, sort, color+size+price combinations, "my size only", budget) goes in query params under a robots.txt `Disallow` pattern, or is client state only. Empty combinations return 404.
- **Pagination:** use `?page=N` with self-canonicals and crawlable links. Exclude page > ~50 from sitemaps.
- **Sitemaps:** generate them from the DB (route handlers `sitemap.ts`/`generateSitemaps` in Next.js), sharded by type, locale and ID range, ≤ 50k each, with a true `lastmod` taken from the outbox `price.changed` and `product.updated` events.
- **Product lifecycle:** temporarily OOS → 200, `availability=OutOfStock`, notify-me plus similar items. Discontinued with a clear successor → 301. One-off outlet units sold out (common in the defect/outlet model) → 410 after a grace period (e.g. 30–90 days, ADR), or 301 to the parent product/category when a near-identical item exists. Avoid mass redirects to the homepage, which Google treats as soft 404s.
- **Rendering:** PDP, store, category → SSR or ISR with on-demand revalidation (`revalidateTag` on price or stock events), because prices change. Price and stock in the HTML must match the JSON-LD and the Merchant feed. Personal widgets (budget, my size) are client islands, not part of the indexable HTML.
- **CWV:** use these as budgets (the master prompt §25 already sets mobile budgets). Use `next/image` with AVIF, priority-load the LCP image, use font-display swap for IBM Plex Sans Arabic, and reserve space for badges to prevent CLS.

### Gaps
- Live text of Google's faceted-nav, pagination, sitemap and hreflang pages was not re-fetched (domain blocked).
- No authoritative 2025–26 figure on how much CWV weighs in ranking.

## 2. Structured data and Merchant Center (Product/Offer, sale prices, condition, returns, shipping)

### Takeaway
Ship Merchant-listing-grade JSON-LD on every PDP, matched 1:1 to a Merchant Center feed. Strikethrough prices must come only from the §9 Verified Reference Price. Defect and open-box grades map to schema.org conditions.

### Cited Findings
- Google's merchant listing markup covers active, sale, strikethrough and member prices. Member pricing (`validForMemberTier`) became a beta around Feb 2025 — [Search Engine Land](https://searchengineland.com/google-adds-member-pricing-beta-type-to-merchant-listing-pricing-structured-data-451908), [SER](https://seroundtable.com/google-merchant-listing-validformembertier-38906.html).
- The strikethrough price is a `UnitPriceSpecification` with `priceType`. Sources conflict on the value: `https://schema.org/StrikethroughPrice` ([eCorpIT/DEV, secondary](https://dev.to/mr_manushukla/product-schema-in-2026-9-fixes-that-decide-if-your-merchant-listings-show-16cm)) vs `ListPrice` ([Digital Thrive, secondary](https://digitalthriveai.com/en-us/resources/seo/google-adds-support-for-sale-pricing-and-pricetype-property/)). **[GSC-memory]** Google documents both: `StrikethroughPrice` is the general strikethrough, `ListPrice` is the manufacturer's list/RRP. **VERIFY**.
- Reported 7 Jul 2026 update: sale date ranges via `validFrom`/`validThrough` in `PriceSpecification`, plus `Product.category` — [TechWyse (unverified)](https://www.techwyse.com/news/search-news/google-merchant-listing-structured-data-sale-duration-product-category).
- Google recommends both on-page markup and a Merchant Center feed — [TechWyse](https://www.techwyse.com/news/search-news/google-merchant-listing-structured-data-sale-duration-product-category). Merchant Center flags price mismatches between the page crawl and the feed and disapproves the item — [VTEX known issue](https://help.vtex.com/en/known-issues/google-merchant-center-is-denying-ads-due-to-price-divergence).
- **[GSC-memory]** Merchant listing: `Product` with `name`, `image`, `offers` (`price`, `priceCurrency`, `availability`), plus recommended `itemCondition` (`NewCondition`, `UsedCondition`, `RefurbishedCondition`, `DamagedCondition`), `gtin`/`mpn`/`brand`, `hasMerchantReturnPolicy` (`MerchantReturnPolicy`: `applicableCountry`, `returnPolicyCategory`, `merchantReturnDays`, `returnFees`, `returnMethod`), `shippingDetails` (`OfferShippingDetails`: `shippingRate`, `shippingDestination`, `deliveryTime` with handling and transit), and `aggregateRating`/`review`. Since 2024–25, return and shipping policies can be set org-wide via `Organization` markup or the Merchant Center settings instead of per offer. `priceValidUntil` is optional. Merchant Center's Strikethrough/sale display rules require the reference price to be a real recent selling price (Google's "sale price" policy); this is consistent with the §9 VRP.
- **[GSC-memory]** Review snippets: self-serving reviews about your own Organization are not eligible. Product reviews from verified buyers are fine.

### Inferences (rules)
- **Price block in JSON-LD:** `price` = the current price. Emit `priceSpecification` with `priceType: StrikethroughPrice` **only when the §9 `claim_allowed` is true**, with the VRP as its value. Brand RRP uses `ListPrice` with its own label. With no claim, there is no strikethrough. The same rule applies in the feed (`sale_price` only when verified). C4 "hidden %" mode → omit the strikethrough from markup too. Member-only display → `validForMemberTier` (Plus).
- **Condition mapping (ADR):** New with tags → `NewCondition`. Sample → `NewCondition`, with a "sample" note in the description. New with imperfections and minor defects → `DamagedCondition`. Open-box returned → `UsedCondition`, or `NewCondition` if unopened (VERIFY against GMC condition policy, which allows only new/refurbished/used in the feed: map Damaged → `used` in the feed with a defect note). Refurbished applies only to professionally restored electronics.
- **Seller:** `offers.seller` = an `Organization` with the seller's legal name (which also covers CPL seller identity). The marketplace operator is the `WebSite`/`Organization` on the homepage. For a Buy Box with several sellers, use `AggregateOffer` (lowPrice/highPrice/offerCount) or one canonical PDP with a primary `Offer`.
- **Returns:** encode the 14-day/30-day CPL policy in `MerchantReturnPolicy` (`merchantReturnDays: 14`, `applicableCountry: EG`), with non-returnable categories flagged. Shipping: free ≥ 2,000 EGP per store is hard to express per store, so model it in Merchant Center shipping settings. **VERIFY** that GMC free listings are available for Egypt.
- Build a CI contract test: JSON-LD price == rendered price == feed price.

### Gaps
- Could not confirm Merchant Center free listings / Shopping availability for Egypt in 2026, or Arabic feed support.
- Exact current `priceType` enumeration and the Jul 2026 change are unverified.

## 3. GEO: how AI engines pick sources, llms.txt, agentic commerce feeds/protocols, AI bot management

### Takeaway
Classic SEO rank is still the strongest, though weakening, predictor of AI Overview citation. Content with statistics, quotes and citations measurably helps. llms.txt is near-useless today. The real GEO levers for a marketplace are clean feeds (Google Merchant Center, the OpenAI ACP feed) and allowing the search/user-fetch bots while separately deciding on training bots.

### Cited Findings
- Princeton/IIT Delhi GEO paper (Aggarwal et al., KDD 2024, arXiv 2311.09735): GEO methods raise visibility by up to 40% on GEO-bench (10k queries), and by up to 37% on Perplexity.ai. Adding quotations, statistics and citations were the top tactics — [arXiv](https://arxiv.org/abs/2311.09735). Per-tactic numbers not re-verified. The lab setting may not transfer to 2026 engines.
- Ahrefs Jul 2025: 76.1% of AI Overview–cited pages ranked in the top 10 (1.9M citations) — [Ahrefs](https://ahrefs.com/blog/search-rankings-ai-citations). Ahrefs update (~Mar 2026): only 38% in the top 10, and 36% outside the top 100 — [Ahrefs](https://ahrefs.com/blog/ai-overview-citations-top-10/), [SEJ](https://www.searchenginejournal.com/google-ai-overview-citations-from-top-ranking-pages-drop-sharply/568637/). BrightEdge reported ~17% overlap (date and method unclear, secondary) — [DesignRush](https://news.designrush.com/ai-overview-citations-drop-ahrefs).
- llms.txt: SE Ranking (Nov 2025) found ~10% of 300k domains have one. HTTP Archive Web Almanac 2025 found ~2%. Ahrefs found 97% of llms.txt files get zero AI requests. Google (Mueller, Jun 2025; Illyes, Jul 2025) says no AI system uses it and Google doesn't support it — [PPC Land](https://ppc.land/llms-txt-adoption-rises-8-8x-but-97-of-files-get-zero-ai-requests/), [PPC Land](https://ppc.land/llms-txt-adoption-stalls-as-major-ai-platforms-ignore-proposed-standard/), [SEO Sherpa](https://seosherpa.com/97-of-llms-txt-files-are-never-read/).
- OpenAI Agentic Commerce Protocol (with Stripe): a product feed (CSV/TSV/XML/JSON, gzip, ≤ 10 GB, refresh as often as every 15 min) plus an agentic checkout spec. Latest stable spec version 2026-01-30 (date-versioned) — [DEV (secondary)](https://dev.to/carlosortet/openais-agentic-commerce-protocol-a-technical-look-at-how-chatgpt-becomes-a-shopping-agent-20fd), [Syndigo](https://syndigo.com/?p=82138). Some platforms use JSONL at a public URL — [Shopware](https://docs.shopware.com/en/shopware-6-en/extensions/agentic-commerce).
- Google Universal Commerce Protocol (UCP): an open standard co-developed with Shopify and launched ~Jan 2026 (NRF). Merchants publish a manifest at `/.well-known/ucp`, with transports REST, MCP and A2A. Checkout appears in AI Mode and Gemini. It requires Merchant Center, and checkout is only for US/CA/AU-eligible products and selected merchants — [Google Merchant Help](https://support.google.com/merchants/answer/16837055), [PPC Land](https://ppc.land/googles-ucp-checkout-help-page-is-finally-here-what-merchants-need-to-know/), [Paz.ai](https://www.paz.ai/glossary/universal-commerce-protocol-ucp). Perplexity reportedly reuses the Google Shopping feed spec, and Copilot uses Microsoft Merchant Center — [Feedoptimise](https://feedoptimise.com/integrations/agentic-commerce) (secondary).
- Bots: GPTBot = training. OAI-SearchBot = ChatGPT search indexing (blocking it removes you from ChatGPT search). ChatGPT-User = user fetches. A Dec 2025 OpenAI doc change says OAI-SearchBot and GPTBot share crawl results. PerplexityBot (index) honors robots.txt. Perplexity-User (user-triggered) generally ignores it — [Searchlab](https://searchlab.nl/gids/ai-crawlers-robots-txt), [Otterly](https://help.otterly.ai/ai-crawlers) (secondary; not primary docs).
- **[GSC-memory]** Google-Extended is a robots.txt token that controls use in Gemini training/grounding. It does **not** affect Google Search inclusion or AI Overviews/AI Mode, which run on Googlebot. To stay out of AIO you need `nosnippet`/`data-nosnippet`, which also hurts normal snippets.

### Inferences (rules)
- **robots.txt default (ADR):** allow Googlebot, Bingbot, OAI-SearchBot, ChatGPT-User, PerplexityBot, Perplexity-User, Claude-SearchBot/Claude-User, Applebot. Owner decision on the training bots (GPTBot, Google-Extended, ClaudeBot, CCBot, Applebot-Extended): the recommended default is **allow** for public catalog pages, because a marketplace wants to be known, while disallowing `/me`, `/checkout`, `/cart`, the APIs and facet params for all bots. Edge bot management (WAF) should verify bot IPs and rate-limit, not hard-block, so drops are protected.
- Don't invest in llms.txt beyond a cheap static file (optional).
- **Priority GEO feeds:** (1) Google Merchant Center feed plus JSON-LD; (2) OpenAI ACP product feed generated from the same pipeline (checkout integration only when EG eligibility and the PSP fit; VERIFY regional availability); (3) UCP later, since it is not available in Egypt today; (4) Bing/Microsoft Merchant Center.
- **Content for citation:** a public price-proof page (addendum #28), a "How we verify prices" methodology, defect passports, store pages with legal identity, size guides, and AR/EN buying guides with real statistics from system data. These are citable, fact-dense pages that match GEO-paper tactics without fake numbers.

### Gaps
- No primary OpenAI, Perplexity or Google bot docs were fetched. ChatGPT Shopping and UCP availability in Egypt or for Arabic is unknown.
- No credible study of AI citation behavior for Arabic queries was found.

## 4. Arabic SEO specifics (dialect vs MSA, Franco-Arabic, slugs)

### Takeaway
Not researched with sources in this pass (tool budget). The guidance below is practitioner reasoning and must be validated with keyword data from Google Keyword Planner or Ahrefs for Egypt.

### Cited Findings
- None found in this pass.

### Inferences
- Egyptian shoppers search a mix of MSA, Egyptian colloquial (e.g. "جزمة" vs "حذاء", "شنطة" vs "حقيبة", "اوكازيون"), English brand names and Franco-Arabic ("fostan", "gazma"). Target the dialect term in titles and H1s where demand shows it, and put MSA synonyms in the body. The internal search synonyms (§4) and the SEO keyword map should share one synonym dictionary.
- Franco-Arabic queries are best captured by the EN locale pages plus on-page synonym text, not by separate Franco pages, which would be thin or duplicate.
- **Slugs:** Arabic UTF-8 slugs are valid and readable in SERPs, but percent-encode into long URLs in shares and logs. A common safe default: an ID-based stable path plus a short slug (`/eg-ar/p/12345-فستان-لينين`), with the Arabic slug on AR pages, the English slug on EN pages, and the ID as the canonical key so slug edits 301 cleanly. Normalize Arabic (no tashkeel, unify alef/ya forms) in slugs.

### Gaps
- No sourced data on MSA vs Egyptian dialect search volume, Google's handling of Franco-Arabic, or the CTR of Arabic vs transliterated slugs.

## 5. Marketplace pitfalls (duplicate content across sellers, thin pages, UGC spam)

### Takeaway
Consolidate identical products from several sellers into one canonical PDP (Buy Box), gate thin store and facet pages out of the index, and nofollow/ugc-qualify user links.

### Cited Findings
- **[GSC-memory]** Google's spam policies (Mar 2024 update): scaled content abuse, site reputation abuse and expired-domain abuse. Google recommends `rel="ugc"`/`nofollow` on user links and moderation of UGC. Duplicate pages are consolidated via `rel=canonical`, which Google treats as a hint.
- The Dec 2024 faceted guidance (above) applies to seller-filtered listings too — [Userp](https://userp.io/news/google-makes-old-faceted-navigation-doc-new-official-guidelines/).

### Inferences (rules)
- One canonical PDP per matched product (the §9.2 GTIN/pHash matching), with other sellers' offers on it. Seller-specific duplicate URLs canonicalize to it or are not generated.
- Seller copy: require unique Arabic titles and descriptions. AI listing copilot output must be reviewed and must not mass-produce boilerplate (scaled-content risk).
- Index a store page only once it has ≥ N live products. Keep facet pages with fewer than N products noindexed.
- Reviews and Q&A: verified purchases only (already in the spec), links set to `rel="ugc nofollow"`, moderation before render, and no indexing of the seller's own review pages.
- Expired drops/events: keep evergreen brand-event hub URLs (e.g. `/eg-ar/drops/brand-x`) updated, instead of a new URL per drop that dies.

### Gaps
- Google Search Central pages could not be fetched for this pass. Before writing the ADR, re-verify the spam policies, faceted navigation, pagination, the merchant listing (strikethrough `priceType`), and Merchant Center country availability for Egypt. Allow developers.google.com in the session network to do this.
