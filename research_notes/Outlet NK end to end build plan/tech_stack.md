# Tech stack and build vs buy for Outlet NK (research as of 2026-11-06)

Scope note: research was limited (9 tool calls). typesense.org was blocked by the session network, so Typesense's own docs could not be read. Every figure carries its year. "UNVERIFIED" means the source is secondary or conflicting.

## Open-source commerce engines for a multi-vendor marketplace

### Takeaway
Medusa v2 plus Mercur (MIT) is the closest open-source fit for the planned TypeScript/Postgres stack. Vendure's multi-vendor support is only an example plugin. Spree 5 is AGPL, and its marketplace module is paid Enterprise. Engines don't provide Outlet NK's hard parts (row-per-unit inventory, double-entry ledger, VRP, Egyptian PSPs), so those stay custom whatever is chosen.

### Cited Findings
- Medusa provides a "Marketplace Recipe" for building multi-vendor setups yourself and points to Stripe Connect for payouts (2025–26) — [Medusa marketplace](https://medusajs.com/marketplace/)
- Mercur is an MIT-licensed marketplace accelerator on Medusa v2. It became a featured Medusa starter in Aug 2025 and includes vendor dashboards, a multi-vendor cart with one checkout, commissions and payouts — [Medusa newsletter Aug 2025](https://medusajs.com/blog/newsletter-aug25/), [GitHub mercurjs/mercur](https://github.com/mercurjs/mercur)
- Mercur handles only the marketplace logic and delegates products, pricing, orders, payments and fulfillment to Medusa — [Mercur docs architecture](https://docs.mercurjs.com/learn/architecture)
- Vendor KYC, EAN dedup and multi-channel sync are in a commercial "Mercur Enterprise" licence (2025–26, per search summary; UNVERIFIED on the official pricing page) — [Mercur docs](https://docs.mercurjs.com/developer-guide/overview)
- Mercur v2.1.6 is reportedly dated 2026-06-05 (third-party listing, UNVERIFIED) — [ecosyste.ms](https://awesome.ecosyste.ms/projects/github.com%2Fmercurjs%2Fmercur)
- Vendure models multi-vendor as Channels per Seller. Its multi-vendor plugin is an example "for educational purposes only", not production-ready — [Vendure docs](https://docs.vendure.io/current/core/how-to/multi-vendor-marketplaces)
- Saleor has no official multi-vendor feature. A community GPL-3.0 plugin was last updated in Jul 2023 (likely stale) — [Saleor-Multi-Vendor](https://github.com/Saleor-Multi-Vendor/saleor-multi-vendor)
- Spree 4.10+ is AGPL-3.0 (4.9 and earlier BSD-3). The marketplace module (vendor onboarding, split payments, Stripe Connect payouts) is in the paid Enterprise Edition from Vendo — [spree repo mirror](https://github.com/spree-forge/spree), [ruby-toolbox](https://www.ruby-toolbox.com/projects/spree_api)

### Inferences
- Medusa and Mercur use Stripe Connect-style splits, which aren't available in Egypt. Payouts, the ledger and the Paymob/Kashier/Fawry/valU adapters would have to be custom anyway, and that's a large share of the hard work.
- Medusa's inventory module is quantity-based. Swapping in row-per-unit SKIP LOCKED reservations means overriding core workflows, which risks upgrade friction. Adopting Medusa saves the catalog, cart and admin CRUD but not the differentiating domain.
- AGPL (Spree) is a licence risk for a SaaS-style marketplace, and Rails doesn't fit a TS monorepo.
- Recommendation: keep the custom NestJS hexagonal monolith for the money, stock and pricing domains, and treat Medusa/Mercur as a reference design or for a throwaway prototype. A time-boxed spike (1–2 weeks) building row-per-unit plus the ledger on Medusa would settle it. Record the result in an ADR.

### Gaps
- Sylius, Bagisto multi-vendor and Sharetribe weren't researched (budget). Known only from background knowledge: Sharetribe is SaaS aimed at service/rental marketplaces, and Bagisto is Laravel. All unverified.
- Arabic/RTL and EGP support for each engine wasn't verified. Admin panel RTL quality is unknown.

## Commercial options

### Takeaway
Shopify has no native multi-vendor support and relies on third-party apps. Mirakl is enterprise and quote-only. CS-Cart's pricing is inconsistent across sources. None of them natively supports Egyptian COD, BNPL, ETA e-receipts, row-per-unit inventory or VRP rules.

### Cited Findings
- Shopify needs third-party apps for multi-vendor (2026). App prices: Shipturtle from $49/mo, MarketFox from $29/mo, Webkul from $15/mo, Multi Seller Marketplace $99.99/mo — [CartCoders](https://cartcoders.com/blog/shopify-marketplace/shopify-multi-vendor-marketplace-pros-cons/), [Shipturtle](https://apps.shopify.com/SHIPTURTLE), [MarketFox](https://apps.shopify.com/marketfox-multivendor-app), [Multi Seller](https://apps.shopify.com/multi-seller-marketplace)
- Webkul deletes seller data within 2 days of uninstall, which creates lock-in and data risk — [Webkul FAQ](https://sp-seller.webkul.com/index.php?p=faqs)
- CS-Cart Multi-Vendor prices conflict (2026): $599/yr (GetApp), $1,250/licence/yr (G2), $1,250 one-off or $61/mo (Garnet), from $95/mo (Fitgap). UNVERIFIED — [GetApp](https://www.getapp.com/website-ecommerce-software/a/cs-cart-multi-vendor), [G2](https://g2.com/products/cs-cart-multi-vendor/pricing), [Garnet](https://garnetmarketplace.com/blog/best-marketplace-platforms.html)
- Mirakl publishes no prices and is enterprise custom-quote — [G2 Mirakl](https://www.g2.com/products/mirakl-inc/pricing)

### Inferences
- Mirakl and VTEX are sized for enterprise retailers adding a marketplace, not for a startup that is the marketplace. Shopify's checkout can't host the one-payment multi-store saga, Egyptian BNPL or the spec's integrity rules. Commercial platforms are a poor fit.

### Gaps
- Nautical, VTEX and Shopify Plus 2026 pricing weren't found. No Egypt-specific limits were confirmed.

## Next.js 15/16 for e-commerce

### Takeaway
Next.js 16.x is current. Cache Components ("use cache") are recommended and become the default in Next.js 17. next-intl needs the `next/root-params` workaround with cached components, so keep the locale in a `[locale]` segment and set `dir` on `<html>`.

### Cited Findings
- The Next.js 16.4 blog calls Cache Components the best choice for every app and the default in Next.js 17 — [Next.js 16.4](https://nextjs.org/blog/next-16-4)
- Cached components can't call `headers()`, which next-intl uses. The workaround passes the locale via `next/root-params` (Next.js PR #91191). next-intl issue #1493 tracks this — [Aurora Scharff demo](https://awesome.ecosyste.ms/projects/github.com%2Faurorascharff%2Fnext-intl-cache-components)

### Inferences
- Use a `[locale]` route with `dir="rtl"` for `ar`, CSS logical properties, RSC for PDP and listing pages, cached catalog with tag revalidation fired from outbox events, and dynamic price and stock holes (the spec requires fresh price and stock).
- PWA and low-end Android CWV guidance wasn't researched. Standard practice is to minimise client JS, use next/image with AVIF and keep a small JS budget (unverified).

### Gaps
- PWA support status, CWV data for Egyptian low-end Android and the next-intl cache-components fix status were not checked.

## Search for Arabic

### Takeaway
Meilisearch's tokenizer (Charabia) has documented Arabic normalization. Typesense's Arabic handling couldn't be verified from its own docs (the host was blocked). OpenSearch/Lucene has a full Arabic analyzer with a stemmer. The spec's default of Typesense should be re-tested before it's locked in by ADR.

### Cited Findings
- Charabia (Meilisearch) does Arabic article (ال) segmentation, digit conversion, diacritics removal, and Tatweel/Alef/Yeh/Taa-marbuta normalization. No Arabic stemmer was confirmed — [Charabia](https://github.com/lzw65/charabia), [Meilisearch language docs](https://meilisearch.com/docs/resources/help/language)
- Meilisearch's own (biased) comparison says Typesense is limited for languages that need complex tokenization, including Arabic — [Meilisearch vs Typesense](https://www.meilisearch.com/blog/meilisearch-vs-typesense)
- Lucene ships ArabicNormalizationFilter and ArabicStemFilter (used by OpenSearch) — [Lucene ar package](https://lucene.apache.org/core/7_5_0/analyzers-common/org/apache/lucene/analysis/ar/package-use.html)

### Inferences
- None of these handles Franco-Arabic transliteration natively, so that needs an app-side normalizer or synonyms whichever engine is used. Recommendation: run a bake-off of Meilisearch vs Typesense vs OpenSearch on about 500 real Egyptian queries (AR, EN, Franco) and use Postgres FTS plus pg_trgm only as the fallback.

### Gaps
- Typesense's Arabic locale and stemming support is unverified (typesense.org must be allowed in the session network). Postgres has no built-in Arabic snowball config in the versions checked from memory (unverified).

## Expo / React Native 2026 and web–native code sharing

### Takeaway
Expo SDK 56 (21 May 2026) ships RN 0.85 and React 19.2, with a known Hermes V1 memory regression that SDK 57 fixes. That makes SDK 57+ the target, which resolves verify-register row 14. Expo UI's universal web components are still experimental, so share logic (domain, Zod, API client, i18n, tokens) rather than screens.

### Cited Findings
- SDK 56 released 2026-05-21 with RN 0.85 and React 19.2. Hermes V1 memory regression affects reanimated/worklets and is resolved in SDK 57 — [Expo SDK 56 changelog](https://expo.dev/changelog/sdk-56)
- Expo UI universal components cover Android, iOS and web (web via react-dom/react-native-web), but the web APIs are experimental — [DEV: Expo SDK 56](https://dev.to/expo/expo-sdk-56-5eb5), [AlternativeTo](https://alternativeto.net/news/2026/5/expo-sdk-56-brings-stable-expo-ui-faster-builds-and-react-native-0-85/)

### Inferences
- With web-first and SEO/CWV priorities, a separate Next.js web app and Expo app sharing the `packages/*` layer is lower-risk than Solito/Tamagui/RNW screen sharing.

### Gaps
- Solito/Tamagui 2026 status and the SDK 57 release date were not checked.

## Team size and timeline benchmarks

### Takeaway
No credible case studies were found in this pass.

### Cited Findings
- A 2026 cost-estimator blog exists (marketing source, not read) — [projectcostestimator](https://projectcostestimator.com/blog/multi-vendor-marketplace-cost-2026)

### Inferences
- The spec's own plan (Phase 0 at 4 weeks, Phase 1 at 12–14 weeks) has no external benchmark in these notes. Treat it as an internal estimate.

### Gaps
- No reliable published benchmarks were found for team sizes or for custom vs engine MVP timelines.
