# ADR-0007: Web first; Android and iOS together in Phase 2

- Status: **Proposed — owner accepted recommendation 2026-11-07; needs counsel/contract confirmation before anything real** (product scope accepted by the owner 2026-11-06 in the vision addendum C1; depends on D6 and D8)
- Date: 2026-11-07
- Deciders: Owner, CTO, SEO lead
- Sources: `docs/outlet-nk-vision-addendum.md` C1; `docs/BUILD-PROMPT.md` §1, §3, §4, §5, §10; `reports/Outlet NK SaaS and defects.md` ("Web first, then apps"); `reports/Outlet NK end to end build plan.md` (stack); `research_notes/Outlet NK engineering standard/seo_geo.md`; master prompt §0, §B7, §B8, §T2

## Context

- The master prompt was **iOS first**, with the shopper web in Phase 3. The owner replaced this (addendum C1): **the shopper website (Next.js, PWA, SEO) launches in Phase 1; Android and iOS ship together in Phase 2.**
- Android is about **88–91%** of Egyptian phones and iOS about 9–12% (StatCounter, cited in the SaaS report). A link opens on any phone with no download, and brands can share their own Brand Street links.
- Discovery through search engines and AI answers needs indexable, fast pages (BUILD-PROMPT §5).
- Launch categories are women's and modest fashion plus kids (D6). The UI and taxonomy are multi-category (UI spec C7), so the web must not assume fashion only.

## Options considered

| Option | Good | Bad |
|---|---|---|
| **A. Web (Next.js PWA) first, Expo apps for both platforms in Phase 2 (chosen)** | Reaches the Android majority with no install; SEO/GEO from day one; one launch surface for a small team; no store review on the critical path | No native push on iOS unless the PWA is installed; no App Attest on web |
| B. iOS first (master prompt v3) | Premium audience; native polish | Misses ~90% of Egyptian phones; Apple review on the critical path; no SEO |
| C. Web + Android + iOS at once | Maximum reach | Three surfaces for ~5 engineers; quality and the 24-week MVP at risk (plan-and-risks risk 25) |
| D. One universal codebase (Expo / React Native Web) for web and apps | Shared screens | Weaker SSR/SEO and Core Web Vitals than Next.js for an SEO-first site; the UI spec's 3D carousels and shelves need web-grade control |

**Choice (2–3 lines):** A gives the widest reach and SEO for the least work, and keeps app-store rules off the MVP path. Apps share `packages/*` (domain, validation, api-client, tokens, i18n) with the web, not screens, so Phase 2 does not redo business logic.

## Decision

### Platforms and phases
- **Phase 1:** `apps/web` (shopper, PWA), `apps/seller-web`, `apps/admin-web`, all Next.js with one `ui-web` design system and the Outlex look (`docs/design/ui-reference-spec.md`).
- **Phase 2:** `apps/mobile` with **Expo SDK 57+** (New Architecture) for Android and iOS together. SDK 57+ follows the build-plan report's finding on the SDK 56 Hermes V1 regression (closes V14 when confirmed at Phase 2 start).

### Web rules that replace app-only rules from the master prompt
| Master prompt (app) | Web replacement |
|---|---|
| App Attest / Play Integrity on OTP, checkout, drops | Cloudflare bot score + **Turnstile** on sensitive flows, device-bound cookie, user/device rate keys (never IP alone: CGNAT) (BUILD-PROMPT §4) |
| Keychain token storage | `HttpOnly; Secure; SameSite` cookies, CSRF tokens on cookie-auth forms, short access token (10 min), rotating refresh with family revocation |
| Native PSP SDK | PSP hosted page or iframe only. We stay in **PCI SAQ A**, and because this is a web merchant page we apply the FAQ 1588 controls: strict CSP with nonces, SRI, a script inventory, and payment-page change detection (master prompt §B8) |
| Push notifications | WhatsApp and SMS for transactional messages (consent rules §24), email, and Web Push where supported (iOS needs the PWA installed; verify on the target iOS versions at build time) |
| Offline cache | PWA service worker caches the shell, bag, wishlist and orders; **never** price or stock |
| Passkeys | WebAuthn passkeys, mandatory for sellers and admins, offered to shoppers |

### URLs, SEO and GEO
- URL shape `/{market}-{locale}/…` (e.g. `/eg-ar/`, `/eg-en/`), as in ADR-0001 and ADR-0006. hreflang clusters `ar-EG`, `en-EG`, `x-default`. No IP geo-redirect.
- SSR/ISR on indexable pages; facet allow-list; sharded sitemaps; JSON-LD with `itemCondition` from our grades (ADR-0009). A reference or strikethrough price appears in markup and feeds **only** when Price Watch/VRP verified it (BUILD-PROMPT §5). A CI test asserts JSON-LD price = rendered price = feed price.
- Performance budgets in CI: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1 at p75; JS ≤ 170 KB gzip on first load for shopper routes. Test on two low-end Android phones (build-plan report).

### Bots and `robots.txt` (owner decision D8)
- **Allow search and user-fetch bots** on public pages: Googlebot, Bingbot, OAI-SearchBot, ChatGPT-User, PerplexityBot, Perplexity-User, Claude-SearchBot, Claude-User, Applebot.
- **Block AI training bots:** GPTBot, Google-Extended, ClaudeBot, CCBot, Applebot-Extended, and new training agents as they are published. The list is config, reviewed quarterly.
- **All bots** are blocked from private routes (`/me`, `/checkout`, `/cart`, APIs, filter parameters outside the allow-list).
- Known limits (seo_geo.md, secondary sources): `robots.txt` is a request, not enforcement; a Dec 2025 OpenAI doc change says OAI-SearchBot and GPTBot share crawl results, so blocking GPTBot may not fully stop training use; Perplexity-User generally ignores `robots.txt`; Google-Extended does not change Google Search or AI Overviews. Cloudflare verifies bot IPs and rate-limits; it does not hard-block search bots during drops.
- Note: the research recommended **allowing** training bots. The owner chose to block them (D8). Owner wins.

## Consequences

**Good**
- Reaches most Egyptian shoppers on launch day; SEO and GEO compound from day one.
- App Store and Play rules are off the MVP critical path (Plus is Phase 2, ADR-0004).
- Shared packages make Phase 2 apps mostly UI work.

**Bad / risks**
- Weaker re-engagement without native push. Mitigation: WhatsApp Channel for drops, opt-in WhatsApp alerts.
- Web bot protection is weaker than device attestation. Mitigation: Turnstile, Waiting Room tokens, per-user/device limits, card-testing detection.
- Web checkout is more exposed to script attacks (SAQ A eligibility depends on it). Mitigation: CSP/SRI/change detection from the first payment page.

## Verify-register rows
- **V10** and **V66** (store rules return in Phase 2, see ADR-0004)
- **V48** Cloudflare Business vs Enterprise for Waiting Room and bot management
- **V14** Expo SDK version at Phase 2 start (proposed SDK 57+)
- **V16** Waiting Room vendor and Cloudflare plan

## Related
ADR-0001, ADR-0004, ADR-0006, ADR-0009 (`itemCondition`), ADR-0010.
