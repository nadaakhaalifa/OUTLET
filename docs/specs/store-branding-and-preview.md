# Store branding (per-store theme) and "Preview as customer" with a "What needs fixing" checklist

Status: **Draft design, not built.** ADR-0057 (Proposed). Template: master prompt A3. Spec refs: 3 (stores, worlds), 4 (sponsored labels), 5 (product page, PriceBlock), 9 (price integrity, badges), 10 (size charts), 16 (truthful social proof), 19 (Seller Center, storefront builder, tenant isolation), 25 (UI/UX, tokens, performance budgets, WCAG 2.2 AA, localisation), 27 (trust and safety, IP), A2.13 (never fake data), B5 (CPL 181/2018: Arabic, seller legal identity), B7 (App Store), T2 (mobile), T5 (upload pipeline, CSP), T10 (image and carbon budgets).
Builds on: ADR-0056 (entitlement `storefront.customisation`, `store_restrictions`), ADR-0051 (no external AI vendor: moderation ports stay Unconfigured until in-house models exist), ADR-0055 (guest browsing), ADR-0054 (iPad zoom), ADR-0028 (kill-switch polarity), `docs/design-system/ux-principles.md`, `docs/design-system/brand-mode.md`, `docs/specs/stores-worlds.md`, `docs/specs/price-integrity.md`, `docs/specs/sizing.md`, `docs/specs/seller-analytics.md`, `packages/ui-tokens/src/index.ts`, `packages/ui-native/src/components/commerce.tsx`, `apps/mobile/src/theme/fonts.ts`.

Owner request (intent): give each brand full control of its store's identity (branding, fonts, vibe) so that a baby shop feels pastel and soft and a luxury label feels elite, different from the Z-OUTLET chrome; and give the brand a button to inspect its store exactly as a customer sees it, with a list of what needs fixing.

Every number below (limits, weights, thresholds, sizes) is an engineering default, admin-configurable where marked. No plan price, tier name or commission is set here (ADR-0056 D1, D2).

---

## 0. What exists today (grep-verified 2026-10-18)
| Area | Today |
|---|---|
| Platform tokens | `packages/ui-tokens/src/index.ts`: semantic `ColorTokens` (light/dark), `nativeTypography`, `radius`, `spacing`, `motion`, `fontFamilies` (Inter, IBM Plex Sans Arabic, Playfair Display, Amiri). AA pairs checked in `drift.test.ts`. |
| Fonts | All bundled at build time (`apps/mobile/src/theme/fonts.ts`, `useFonts`, 4 s timeout, system-font fallback). No runtime font loading. |
| Commerce kit | `StoreName`, `Badge`, `PriceBlock`, `ProductCard`, `StoreCard`, `Rating` in `packages/ui-native/src/components/commerce.tsx`. All read platform tokens. |
| Store page | `GET /v1/stores/{id}` returns profile + legal identity projection (`store_legal_identity_public`). No logo/cover/theme fields beyond the card images. |
| Entitlement | ADR-0056 defines `storefront.customisation` (`standard`, `branded`, `custom_sections`); not built. |
| Brand mode (in-app) | Dashboard, Products, Orders, Store tabs (`apps/mobile/src/features/brand-mode`). Publish gate already lists what a product is missing. No preview. |
| Seller Center web | No storefront or theme page, no preview. |
| Mobile web target | None (`react-native-web` is not a dependency): matters for section 9.3. |
| Moderation | Review moderation exists in `apps/api/src/modules/reviews`; no image classifier port for brand assets. |

---

## 1. Theming architecture: options and choice

### 1.1 How a store theme is expressed
| Option | Complexity | Accuracy (fidelity + honesty) | Cost | Scalability |
|---|---|---|---|---|
| (a) Seller-authored templates or CSS/markup (Shopify Liquid-style, remote components) | very high: a renderer per platform, sandboxing, code review | maximal freedom, but cannot run natively without shipping code (App Store 2.5.2 risk), and cannot guarantee that price, discount and legal elements stay intact | high (security review per theme) | poor: every theme is a new attack and QA surface |
| (b) Presets only (pick one of N platform "moods") | low | safe, but cannot deliver "totally different" brands; every baby shop looks the same | low | good |
| (c) **Typed theme document**: closed set of roles (palette, type pairing from an allow-list, shape, density, motion mood, imagery, section layout) validated by Zod, compiled by the platform into tokens, applied by a scoped provider; presets are just pre-filled documents | medium | high: brands look distinct, while locked components never read store tokens, so honesty is structural | medium | good: one renderer, data-only themes, new roles added by schema version |

**Choice (c).** It is data, not code, so it renders natively, needs no per-theme code review, and lets a lint rule plus contract tests prove that price, discount, verified, sponsored and legal elements cannot be themed. Presets (b) ship inside (c) as starting points.

### 1.2 How fonts reach the app
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (i) Bundle every allow-listed font in the binary | low | instant render | app size grows by several MB per added pair (Arabic families are large); every font change needs a store release | poor beyond a handful of pairs |
| (ii) **Download on demand** from the platform CDN, SHA-256 pinned, cached on disk, platform font fallback | medium | first visit may fall back (bounded wait), later visits exact | bytes only for stores actually visited | good: catalogue grows without releases |
| (iii) Seller uploads any font file | high (sanitising, licences) | maximal | licence and malware risk | n/a |

**Choice (ii)** for the curated catalogue; (iii) is **off** pending owner decision O3. Platform fonts stay bundled as today, so any failure degrades to the current look, never to a broken screen.

---

## 2. Theme model

### 2.1 Theme document (schema version 1, stored as `jsonb`, validated by Zod in `packages/validation`)
All values are closed enums, bounded integers or `#RRGGBB` strings. There are **no free-form CSS, style, URL or font-name strings anywhere** in the document.

| Group | Field | Type and bounds | Notes |
|---|---|---|---|
| meta | `schemaVersion` | literal `1` | migrations of the document are pure functions, tested |
| meta | `presetKey` | enum from `theme_presets` or `null` | origin only; the document is the truth |
| palette | `light.{background, surface, text, textMuted, accent, onAccent, border, heroScrim}` | `#RRGGBB` (scrim: hex + alpha 0..0.8) | 8 store roles; nothing else is store-controllable |
| palette | `dark.{same keys}` or `null` | as above | `null` = derived by the platform (2.4) |
| palette | `schemePolicy` | `follow_system` (default) \| `light_only` \| `dark_only` | fixed schemes need entitlement and O4 |
| type | `pairingId` | FK to `font_pairings` (ACTIVE) or `platform_default` | a pairing is always Arabic + Latin |
| type | `displayScale` | enum `modest` (0.92) \| `standard` (1.0) \| `editorial` (1.12) | multiplies **display steps only** (`hero`, `display`, `title1`, `quote`); body, callout, caption and Dynamic Type stay platform |
| type | `displayWeight` | enum `regular` \| `medium` \| `semibold` (must exist in the pairing) | |
| shape | `radius` | enum `sharp` (0/4) \| `soft` (platform 14/18) \| `round` (22/28) \| `pill` | maps to card and image radius only; controls keep kit radius |
| density | `grid` | enum `airy` \| `regular` \| `compact` | maps to `adaptiveGrid` density 1..3 |
| motion | `mood` | enum `still` \| `calm` (platform default) \| `lively` | `lively` = platform `glide` spring + stagger; never bounce; Reduce Motion forces `still` |
| imagery | `cardAspect` | enum `3:4` \| `4:5` \| `1:1` | |
| imagery | `imageBackdrop` | enum `none` \| `surface` \| `accent_soft` | fill behind cut-out images |
| brand | `logoAssetId`, `wordmarkAssetId`, `coverAssetId` | FK to `brand_assets` with status APPROVED | no URLs, only asset ids |
| brand | `tagline.{ar, en}` | text, AR required if any, max 80 chars, plain text, no emoji control chars, no URLs | escaped at render; copy-lint rules apply (no numeric social proof, no "% off", no timers) |
| layout | `sections[]` | max 8; each `{kind, ...}` with kind enum `hero`, `featured_collection` (collection id), `product_grid` (sort enum), `editorial_text` (AR/EN text, max 400 chars), `lookbook` (asset ids, max 6), `category_shortcuts` | `custom_sections` entitlement gates kinds beyond `hero` + `product_grid` |

Size cap: compiled document <= 8 KB gzip (validator rejects larger).

### 2.2 Presets ("mood" starting points, platform-managed rows in `theme_presets`)
Seeded examples (names illustrative; final list is a design task): `soft_pastel` (light pastel surfaces, rounded, airy, calm, rounded sans pairing), `quiet_luxury` (near-black or ivory, sharp, editorial serif pairing, still), `street` (high-contrast, compact, bold grotesque pairing, lively), `natural` (warm neutrals, soft), `classic` (= platform look). Each preset passes the accessibility guard in both schemes (CI test over every preset).

### 2.3 Curated font allow-list (`font_catalog`, `font_pairings`)
Rules for a font to enter the catalogue (platform design + ops, never sellers in v1):
- Licence permits embedding in apps and web (SIL OFL 1.1 or Apache 2.0 preferred). The licence file is stored with the family; the SPDX id is a column. **VR-ST-01**: confirm per family from its own licence file at ingestion; this spec does not assert any family's licence.
- Arabic families must cover Arabic + Arabic Supplement, Western and Eastern Arabic digits, and pass the Arabic review pack (`docs/design-system/arabic-review-pack.md`) at caption size; display-only faces are flagged `display_only` and can never be the body face.
- Subset to Arabic + Basic Latin + Latin-1 + digits + EGP sign glyphs; per-weight file <= 350 KB after subsetting; at most 2 weights per family used by a theme.
- Ingestion runs the file through an OpenType sanitizer (OTS or equivalent) in an isolated job, strips non-required tables, computes SHA-256, uploads to the font CDN path `/fonts/{sha256}.ttf` (immutable, long cache).

Candidate families for the design team to evaluate (all believed to be openly licensed; each still subject to VR-ST-01): Arabic: IBM Plex Sans Arabic, Amiri, Cairo, Tajawal, Almarai, Readex Pro, El Messiri, Reem Kufi, Noto Naskh Arabic, Noto Kufi Arabic, Baloo Bhaijaan 2, Lalezar (display only). Latin: Inter, Playfair Display, Cormorant Garamond, Bodoni Moda, DM Sans, Nunito, Quicksand, Fredoka, Montserrat, Josefin Sans. Pairings are curated (e.g. a rounded Arabic sans with a rounded Latin sans for "soft pastel"; Amiri or El Messiri with a Didone for "quiet luxury"); the pairing table, not the seller, guarantees that both scripts match in weight and x-height.

Brand-proprietary fonts (a luxury label's own typeface) are **not** supported in v1: they are usually commercially licensed with separate app-embedding terms. See O3 and VR-ST-01.

### 2.4 Dark scheme derivation
If `dark` is `null`: convert each light role to OKLCH, map lightness `L' = 1 - L` with roles re-paired (background darkest, text lightest), keep hue, cap chroma to the sRGB gamut, then run the contrast solver (3). The seller sees the derived palette in the editor and may override it (entitlement `branded` and above).

---

## 3. Accessibility guard (automatic, server-side and in the editor)

### 3.1 Checked pairs (both schemes, WCAG 2.x relative-luminance contrast ratio)
| Foreground | Background | Minimum | WCAG |
|---|---|---|---|
| `text` | `background`, `surface` | 4.5:1 | 1.4.3 |
| `textMuted` | `background`, `surface` | 4.5:1 | 1.4.3 |
| `onAccent` | `accent` | 4.5:1 | 1.4.3 (button labels are small text) |
| `accent` | `background`, `surface` | 3:1 | 1.4.11 (non-text UI, focus, selected) |
| `border` (used as control outline) | `background`, `surface` | 3:1 | 1.4.11 |
| `text` (price numerals, see 4.2) | card surface | 4.5:1 | 1.4.3 |
| platform `onImage` (white) over cover | cover image under the header text box, scrim applied | 4.5:1 against the 95th-percentile luminance of the covered region | 1.4.3 |
| locked capsule surface (platform) | store `background` | 1.5:1 (separation, not a WCAG criterion; configurable) | honesty: locked badges stay visually distinct |

### 3.2 Reject vs auto-adjust
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| Reject only | low | correct but frustrating; sellers guess | support load | fine |
| Silent auto-fix on publish | low | brand colour changed without consent | trust risk | fine |
| **Suggest nearest passing colour, require explicit accept** | medium | correct, seller keeps control | low | fine |

**Choice: suggest and require accept.** Solver: in OKLCH keep hue, binary-search lightness (then chroma if needed) toward the side that raises contrast; return the passing colour with the smallest delta-E 2000 from the original. Cover scrim: raise `heroScrim` alpha until the cover check passes (max 0.8, else reject the cover for header use and suggest a different crop). Publishing is **refused** (`422 theme_contrast_failed` with the failing pairs) while any pair fails. Pure function in `packages/ui-tokens` (shared by api, seller-web, mobile), property-tested: output always passes, hue preserved within 2 degrees when achievable, idempotent.

If the platform raises a threshold or adds a pair later, live themes are re-checked; a failing live theme keeps rendering with the auto-adjusted values computed by the platform at compile time (never shown inaccessible) and the store gets a `high` item in the checklist (section 10).

---

## 4. Zones: what a theme may and may not touch

### 4.1 Themed zones
| Surface | Themed | Notes |
|---|---|---|
| Store page (header, cover, logo, tagline, sections, in-store product grid) | fully | primary identity surface |
| Product cards **inside** the store page | card surface, radius, aspect, image backdrop, title font, text colours | locked slots below stay platform |
| PDP of the store's product | "brand band" only: header strip (logo, background tint), title and description font, non-commerce accents | entitlement-gated; decision O2 |
| Store-scoped search and "My Stores" scoped feed | header only | |
| Shop Everything, search results, Buy Box, home feeds, bag, checkout, orders, returns, payments, account, notifications | **never** | platform chrome; a store appears with its logo only |

### 4.2 Platform-locked elements (never read store tokens)
`PriceBlock` (price font, strike-through, % off, VRP label, "Lowest in 30 days", "Launch price", installment line), verified-discount and price badges (spec 9.6), "Sponsored" label (spec 4), Plus badge, stock and scarcity lines ("2 left in M"), rating and review counts, size recommendation and fit confidence, delivery ETA and return-eligibility lines, seller legal identity block (B5), Add to bag / Buy now / checkout CTAs, consent and legal links, AI-suggestion labels, error and offline states.

Rules:
1. Locked components render inside a **platform capsule** (platform surface, border, font, colours) or, for the price numerals, in the platform font with the store `text` colour only after the 4.5:1 check (3.1). The discount, strike-through and badges are always platform colours.
2. A theme cannot hide, reorder, overlap, shrink or change opacity of a locked element: product-card layout has reserved slots (`priceSlot`, `claimSlot`, `sponsoredSlot`) whose position and size come from the kit, not the theme.
3. Brand assets and taglines must not contain price, discount, scarcity, timer, "verified" or rating claims (copy-lint on text; OCR or human review on images, section 7). This closes the bypass "cover image says -70%".
4. Enforcement: new ESLint rule `DS-THEME-LOCKED` in `tooling/design/rules.mjs` forbids importing `useStoreTheme` in locked component files and in `features/{bag,checkout,orders,returns,pdp/price*}`; contract test renders every locked component under an adversarial theme (max chroma magenta, `display_only` font, sharp radius, dark-only) and asserts style equality with the platform render; visual regression snapshots per locked component.

---

## 5. Storage, versioning, publishing, rollback

### 5.1 Data (new module `storefront`, tenant = store, RLS by `app.current_store_id`)
| Table | Key columns | Indexes | PII |
|---|---|---|---|
| `store_themes` | `store_id PK, live_version_id NULL, draft_version_id NULL, etag, updated_at` | PK | P0 |
| `store_theme_versions` | `id, store_id, version int, schema_version, document jsonb, compiled jsonb, content_hash (sha256 of compiled), status DRAFT\|PUBLISHED\|SUPERSEDED\|REJECTED, a11y_report jsonb, entitlement_snapshot jsonb, created_by, created_at, published_by, published_at` ; UNIQUE `(store_id, version)`; immutable once not DRAFT (trigger) | `(store_id, status)`, `(content_hash)` | P1 (actor ids) |
| `brand_assets` | `id, store_id, kind logo\|wordmark\|cover\|section_image\|lookbook, original_key (private bucket), derived jsonb (AVIF/WebP/PNG sizes, CDN keys, bytes, width, height), sha256, phash, mime_sniffed, status PENDING_SCAN\|PENDING_REVIEW\|APPROVED\|REJECTED\|REVOKED, reasons text[], uploaded_by, reviewed_by, created_at` | `(store_id, status)`, `(phash)` | P1; image content may show people: see VR-ST-05 |
| `font_catalog` | `id, family_key UNIQUE, script latin\|arabic, display_only bool, weights jsonb {weight: {sha256, bytes, cdn_key}}, licence_spdx, licence_file_key, source, status ACTIVE\|RETIRED, added_by, approved_by` | `family_key` | P0 |
| `font_pairings` | `id, arabic_font_id, latin_font_id, mood_tags text[], status, approved_by` | | P0 |
| `theme_presets` | `key, document jsonb, status, version` | | P0 |
| `store_theme_events` | append-only: `store_id, version_id, action draft_saved\|published\|rolled_back\|rejected\|disabled_by_platform\|reenabled, actor, reason_code, at` (also written to the hash-chained `audit_log`) | `(store_id, at)` | P1 |
| `listing_quality_config_versions` | section 10.3 | | P0 |
| `listing_quality_snapshots`, `store_readiness_snapshots` | section 10.5 | `(store_id, computed_at)` | P1 |
| `store_preview_sessions` | `id, store_id, actor_id, actor_kind seller\|admin, target live\|draft, theme_version_id, reason_code (admin only), expires_at, created_at` | `(store_id, created_at)` | P1 |

`data_inventory.yaml` tags every column (CI gate); retention: theme versions kept while the store exists + the store's catalogue retention after OFFBOARDED (ADR-0056 1.3: 90 d); rejected assets deleted after 30 d (reason kept); preview sessions 90 d.

### 5.2 Lifecycle
```
(no theme) --save draft--> DRAFT --publish (all gates pass)--> PUBLISHED (live pointer moves; previous PUBLISHED -> SUPERSEDED)
DRAFT --discard--> (deleted, never visible)
SUPERSEDED --rollback--> live pointer moves back to it (status PUBLISHED again; no new version; event rolled_back)
PUBLISHED|SUPERSEDED --platform reject (asset revoked, T&S)--> REJECTED (if live: store falls back to the last PUBLISHED version without that asset, else platform default)
```
Publish gates (all server-side, in one transaction): schema valid; every referenced asset APPROVED; every pair passes (3); entitlement allows every used field (6); store has no restriction `no_custom_theme`; kill switch allows theming. Publishing writes the outbox event `store_theme.published` in the same transaction; CDN and app caches invalidate on it. At most one DRAFT per store; editing uses `If-Match` on `store_themes.etag` (412 on stale). Keep the last 50 versions plus the live one; older SUPERSEDED versions are pruned.

---

## 6. Entitlements (config-driven, ADR-0056 model; no prices)
Extend the existing `storefront.customisation` enum and add typed keys to `entitlement_definitions`:
| Key | Kind | Enforcement point | Downgrade policy |
|---|---|---|---|
| `storefront.customisation` (exists) | enum `standard` \| `branded` \| `custom_sections` | theme publish, section kinds | immediate: rendering falls back to the highest allowed level; the live document is kept, not edited |
| `storefront.palette` | enum `preset` \| `custom` | publish | immediate (custom colours replaced by the preset's at compile time) |
| `storefront.fonts` | enum `platform` \| `curated` | publish | immediate (platform pairing) |
| `storefront.scheme_policy_fixed` | bool | publish | immediate (`follow_system`) |
| `storefront.pdp_band` | bool | PDP render | immediate |
| `storefront.cover_video` | bool (default false everywhere; O5) | publish | immediate (poster frame) |
| `storefront.max_sections` | int | publish | immediate (extra sections hidden) |
| `storefront.preview_states` | bool | preview state simulation (9.4) | immediate |

Which tier gets which value is **owner decision O1** (depends on ADR-0056 D1/D2). Engineering default until decided (all stores, fees 0 per ADR-0056 default B): `branded`, `custom`, `curated`, `pdp_band=false`, `cover_video=false`, `max_sections=4`, `scheme_policy_fixed=false`, `preview_states=true`. **Preview and the "What needs fixing" checklist are never tier-gated**: they protect shoppers, not just the seller. Entitlement reads fail closed to the fallback plan's values (ADR-0056 decision 8); downgrades never delete a theme version.

---

## 7. Brand asset pipeline and moderation
1. `POST .../brand-assets/uploads` returns a presigned PUT to the private quarantine bucket (max 10 MB; content types `image/jpeg`, `image/png`, `image/webp`, `image/heic`). **SVG, GIF, PDF and fonts are refused** (script and parser attack surface).
2. Worker: magic-byte sniff, decode in a sandboxed image worker with pixel-count cap (40 MP), AV scan, strip EXIF/GPS/XMP, re-encode (AVIF + WebP + PNG fallback for logos with alpha), derive sizes (logo 96/192/384 px; cover 750/1170/1536/2048 px wide), compute `sha256` and `phash`. Status `PENDING_REVIEW`.
3. Checks:
   - **Content safety**: `ImageModerationPort` (nudity, violence, hate symbols). Per ADR-0051 it is **Unconfigured** at launch, so every asset goes to the Trust and Safety human queue (SLA 1 business day, configurable). When an in-house classifier exists: auto-approve below a risk threshold, auto-reject above, human in between.
   - **Claims in images**: `ImageTextPort` (OCR, Unconfigured at launch, human review meanwhile) flags `%`, `خصم`, `off`, digits next to EGP or ج.م, countdown patterns, "verified"/"موثق"; any hit = reject with reason `asset_contains_claim` (4.2 rule 3).
   - **IP and impersonation**: pHash Hamming distance against (a) all other stores' APPROVED logos and wordmarks, (b) the restricted-brand mark list (ADR-0056 D11), (c) Z-OUTLET's own marks. Near match = hold for T&S with the matching store or brand; a mark on the restricted list needs a VERIFIED `brand_authorizations` row for that brand (ADR-0056 1.6). Brand-owner notice-and-takedown (spec 27, 48 h) can revoke an asset (`REVOKED`), which recompiles the live theme without it.
   - **Minors in imagery** (baby and kids shops): the content policy and any consent requirement are counsel decisions (VR-ST-05). Default: the moderation queue applies the platform's general safety policy; no special rule is invented here.
4. Approved derivatives are copied to the public CDN path `/brand/{store_id}/{sha256}.{ext}` (immutable, `Cache-Control: public, max-age=31536000, immutable`). Assets are referenced by id only.

---

## 8. Delivery to the Expo app and the web apps

### 8.1 API (audience `seller_api` for seller routes, store-scoped, foreign store = 404 byte-identical to missing; Problem+JSON; writes require `Idempotency-Key`)
| Route | Scope / roles | Idem | Rate limit |
|---|---|---|---|
| `GET /v1/stores/{storeId}/theme` (public, compiled live theme; `ETag` = content_hash; `Cache-Control: public, max-age=300, stale-while-revalidate=86400`) | public (guest allowed, ADR-0055) | n/a | 120/min per IP (edge cached) |
| `GET /v1/stores/{storeId}` and `GET /v1/stores` (additive field `theme: {hash, logo, accent}` so cards and caches know staleness) | public | n/a | existing |
| `GET /v1/seller/stores/{storeId}/theme` (live + draft + history page) | `store_branding:read` | n/a | 60/min |
| `PUT /v1/seller/stores/{storeId}/theme/draft` (full document, `If-Match`) | `store_branding:edit_draft` | yes | 30/min |
| `POST /v1/seller/stores/{storeId}/theme/draft/check` (pure: schema, a11y report with suggestions, entitlement diff; no write) | `store_branding:read` | n/a | 60/min |
| `DELETE /v1/seller/stores/{storeId}/theme/draft` | `store_branding:edit_draft` | yes | 10/min |
| `POST /v1/seller/stores/{storeId}/theme/publish` (body: `draftVersionId`, `acceptedAdjustments[]`) | `store_branding:publish` | yes | 10/min |
| `POST /v1/seller/stores/{storeId}/theme/rollback` (body: `versionId`) | `store_branding:publish` | yes | 10/min |
| `POST /v1/seller/stores/{storeId}/brand-assets/uploads` | `store_branding:edit_draft` | yes | 20/hour |
| `GET /v1/seller/stores/{storeId}/brand-assets?status=` | `store_branding:read` | n/a | 60/min |
| `GET /v1/seller/theme/catalog` (presets, pairings with preview glyph images, entitlement-filtered) | any member | n/a | 60/min |
| `POST /v1/seller/stores/{storeId}/preview-sessions` (section 9) | `store_branding:read` | yes | 30/hour |
| `GET /v1/seller/stores/{storeId}/readiness` (section 10) | owner, manager, catalog | n/a | 30/min |
| Admin `GET /v1/admin/brand-assets?status=PENDING_REVIEW`, `POST /v1/admin/brand-assets/{id}/decision` | trust_safety | yes | 60/min |
| Admin `POST /v1/admin/stores/{storeId}/theme/disable` / `enable` (reason code; adds or lifts restriction `no_custom_theme`) | trust_safety, ops | yes | 30/min |
| Admin `POST /v1/admin/stores/{storeId}/preview-sessions` (reason code, audited) | ops, support, trust_safety | yes | 30/hour |
| Admin `GET/POST /v1/admin/listing-quality/config` (new version, effective-dated) | ops request, second ops or super_admin approves | yes | 10/min |
| Admin `GET/POST /v1/admin/fonts`, `/font-pairings` (ingest, retire) | ops (design owner) with security approval | yes | 10/min |

Compiled theme payload (response of the public theme route, Zod `CompiledStoreTheme`): `hash`, `schemeColors.{light,dark}` (8 roles, already contrast-solved), `scrim`, `typography.{arabic, latin}: {weights: {w: {url, sha256, bytes, family}}}` (family names namespaced `zt_{fontId}_{weight}`), `displayScale`, `radius`, `grid`, `motion`, `cardAspect`, `imageBackdrop`, `assets.{logo, wordmark, cover}: {srcset[], blurhash, width, height}`, `tagline`, `sections[]`, `schemePolicy`, `entitlementLevel`. Font and asset URLs are always on the two platform CDN hosts; clients refuse any other host.

### 8.2 Mobile runtime
- `StoreThemeProvider` (ui-native) wraps the store page subtree; exposes `useStoreTheme()`; everything outside it and every locked component uses the platform theme (4.2).
- Theme cache: MMKV (non-sensitive instance), keyed by `storeId`, holds the last compiled theme + hash; max 100 entries LRU. The store list's `theme.hash` tells the app when to refetch; otherwise revalidate with `If-None-Match`.
- Font loader: download with `expo-file-system` to `cacheDirectory/fonts/{sha256}.ttf`, verify SHA-256 before registering with `expo-font` `loadAsync` under the namespaced family; disk LRU cap 30 MB; a hash mismatch deletes the file and falls back. **VR-ST-06** (engineering): confirm the Expo SDK 57 `expo-font` API for registering local files at runtime and any per-process family limit, against current docs, before build.
- First-visit policy: show the store header skeleton for at most 300 ms waiting for cached-or-downloaded fonts; if not ready, render this visit with platform fonts and **do not swap mid-view** (no layout shift); the next visit uses the brand fonts. Palette, logo and cover never wait on fonts.
- Prefetch: themes (JSON only) for My Stores favourites on app start; fonts for favourites only on Wi-Fi and not in Low Power / Low Data mode (T10).
- Offline: last cached theme and fonts; if none, platform theme with the store logo if cached. Never a blank or broken store page.
- Budgets: JS bundle stays < 6 MB (theme engine + contrast helpers target < 25 KB minified, no new heavy dependency); theme JSON <= 8 KB gzip; fonts per store <= 4 files and <= 1 MB total; cover above the fold <= 250 KB at device DPR (AVIF/WebP); store page p95 first meaningful paint < 1 s on 4G with a warm theme cache, < 1.5 s cold; scroll at 60/120 fps with FlashList (theme values memoised, no per-cell context lookups of the whole theme).
- RTL: the theme never sets direction; layout uses logical start/end (rule 3). Section kinds mirror. Cover focal point stored as `{x,y}` and mirrored in RTL.
- iPad (ADR-0054): theme sizes are effective points; the kit zoom applies as everywhere.

### 8.3 Web (Seller Center editor and preview, admin console)
Compiled theme becomes CSS custom properties on a scoped container via `element.style.setProperty(name, value)` with values re-validated by the same Zod schema (never string-concatenated CSS); `@font-face` rules generated from the compiled payload only, with `font-src` restricted by CSP to the font CDN; `img-src` to the brand CDN; strict CSP with nonces (B8 posture unchanged).

---

## 9. "Preview as customer"

### 9.1 Flow
- **Seller Center web**: button "Preview as customer" on the dashboard, on the storefront editor and on every product page; opens `/storefront/preview?target=live|draft`.
- **In-app brand mode**: "Preview as customer" on the Store tab and the Dashboard; pushes the real shopper store screen inside a preview container.
- **Admin console**: "Inspect as customer" on a store's page (ops, support, trust_safety), reason code required, audited, read-only.
- **"Open on my phone"**: the web preview shows a QR / universal link that opens the in-app preview on the seller's own device (exact native rendering).

### 9.2 Controls
Device frame (iPhone compact, iPhone large, iPad portrait, iPad landscape; web only, the app uses the real device), language AR/EN, scheme light/dark (ignored if `schemePolicy` is fixed, shown as such), persona (guest per ADR-0055; signed-in shopper; Plus member: changes delivery and Plus messaging only), target (live or draft theme; optionally "include unpublished listings", each such listing wears a "Not visible to shoppers" ribbon), and state simulation (9.4).

### 9.3 Rendering fidelity on the web: options
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| (a) Render the real ui-native components through `react-native-web` in a sandboxed iframe | medium-high (not a dependency today; Reanimated, BlurView and expo-image need web paths) | high, same component code | build + spike | good |
| (b) Separate React DOM preview renderer fed by the same compiled theme | medium | drifts from native over time | ongoing parity work | medium |
| (c) Server-side screenshots from simulators | high (device farm) | exact pixels, but static and slow (seconds) | infra cost | poor at scale |

**Choice: in-app preview is the source of truth (exact, real code). For the web, spike (a) first (VR-ST-07, architect); if the spike fails the kit's web constraints, fall back to (b) with visual-regression parity tests against native snapshots and a visible "Close approximation; open on your phone for an exact view" note.** (c) is rejected on cost and latency.

### 9.4 Sandbox and read-only guarantees
- `POST .../preview-sessions` returns a preview token: audience `store_preview`, claims `{storeId, target, themeVersionId, persona, actorId}`, TTL 15 min, not refreshable, bound to the session's device key where the platform supports it.
- The API gateway accepts preview tokens **only** on an allow-list of GET routes (store, theme, catalogue, product, price evidence summary, size chart, reviews read). Every other route returns `403 preview_read_only`. Cart, wishlist, follow, checkout, reviews write, Q&A, alerts, analytics ingest and notifications reject it. The app's preview container also disables those CTAs (shows "Disabled in preview"); the server rule is the guarantee, the UI is a courtesy.
- **No signal pollution**: preview requests are excluded from impressions, views, search and ranking features, seller analytics and Buy Box inputs (gateway tags `x-preview: 1`; analytics ingest drops them; tested).
- **Personas are synthetic**: no real shopper's data is ever loaded. The "signed-in" persona uses a fixture size profile (e.g. M) and no address beyond a governorate for ETA.
- **State simulation** (entitlement `storefront.preview_states`, default on): a gallery that shows each product card and PDP in the states it can take (verified discount, lowest in 30 days, launch price, plain price; in stock, low stock <= 5, out of stock; size chart present or missing; recommendation confident or "not sure"). Every simulated state is rendered with a diagonal "Simulation" watermark and comes from the preview service, never from writing data. Real states are shown without the watermark. Simulated states are never cacheable (`Cache-Control: no-store`) and never reachable with a shopper token.
- Draft data: draft theme and unpublished listings are only reachable with a preview token whose `target=draft` and whose store matches.

### 9.5 Preview API
`POST /v1/seller/stores/{storeId}/preview-sessions` body `{target, persona, includeUnpublished}` -> `{token, expiresAt, deepLink, qrPayload}`; same for admin with `reasonCode`. Events: `store_preview.session_started` (outbox, audit), analytics `store_preview_opened(device, locale, scheme, persona, target)`.

---

## 10. "What needs fixing" checklist (server-computed)

### 10.1 Checks (defaults; every weight, threshold and severity is admin-configurable per 10.3)
Product-level (apply to listings in status published or scheduled):
| Key | Condition | Severity | Weight | Fix deep link |
|---|---|---|---|---|
| `ar_title_missing` | Arabic title empty (B5: Arabic mandatory) | blocker | 15 | product edit, title field |
| `ar_description_missing` | Arabic description empty or < 40 chars | high | 8 | product edit, description |
| `untranslated_fields` | an attribute or option label missing in AR, or EN text identical to AR where EN is set (copy-paste) | medium | 4 | product edit, field |
| `size_chart_missing` | apparel or footwear type without a validated chart (spec 10: no recommendation possible) | high | 10 | size charts |
| `photos_below_min` | photo count < N (N = 4); score `min(1, count / N)` | medium | 6 | product media |
| `image_low_resolution` | longest source side < 1200 px | low | 3 | product media |
| `image_payload_over_budget` | first image's delivered size at 3x DPR > 400 KB above the fold (T10 budget) after re-encode | medium | 3 | product media (re-upload hint) |
| `defect_photos_missing` | condition "minor defect" without defect photos (spec 4) | blocker | 10 | product condition |
| `no_verified_price_evidence` | no VRP (spec 9): the listing shows a plain price. Informational, never a reason to inflate a reference; fix = connect a channel or wait for history | medium | 4 | channels / price trust |
| `price_trust_low` | Price Trust Score < 50 | medium | 5 | price trust page |
| `stock_out_still_live` | every variant has 0 available units and the listing is published | high | 8 | inventory / pause listing |
| `core_attributes_missing` | category, colour or material missing (filters cannot find it) | low | 3 | product attributes |

Store-level:
| Key | Condition | Severity | Weight | Fix deep link |
|---|---|---|---|---|
| `legal_identity_missing` | legal name AR, commercial register no., tax card no. or governorate not published (B5; store is hidden until fixed) | blocker | 20 | settings, profile |
| `return_policy_missing` | no return policy saved | blocker | 10 | settings, returns |
| `store_ar_description_missing` | Arabic store description empty | high | 6 | storefront editor |
| `theme_contrast_failing` | live theme needs platform auto-adjustment (3.2) or draft fails | high | 6 | storefront editor, palette |
| `logo_missing` | no APPROVED logo | medium | 4 | storefront editor |
| `cover_missing` | no APPROVED cover | low | 2 | storefront editor |
| `assets_rejected_or_pending` | any referenced asset REJECTED or PENDING_REVIEW > SLA | high | 4 | brand assets |
| `font_retired` | live pairing RETIRED (rendering uses platform fallback) | low | 2 | storefront editor, type |

### 10.2 Score formula
For listing p with applicable checks A_p (a check is applicable only if its precondition holds, e.g. size chart only for apparel and footwear):
```
LQS(p) = round( 100 * sum_{i in A_p} w_i * s_i(p) / sum_{i in A_p} w_i )        s_i in [0, 1], 1 = passes
if any blocker fails on p: LQS(p) = min(LQS(p), cap_blocker)                      cap_blocker = 49
StoreChecks = 100 * sum_{j in S} w_j * s_j / sum_{j in S} w_j  (same blocker cap)
CatalogueScore = mean of LQS(p) over live listings (equal weights; 100 if no live listings, with the item "No live listings")
SRS (store readiness) = round( alpha * CatalogueScore + (1 - alpha) * StoreChecks ),  alpha = 0.6
if any store-level blocker fails: SRS = min(SRS, cap_blocker)
```
Integer arithmetic on weights (bps), half-even rounding at the single final step; pure function in `packages/domain/src/storefront/readiness.ts`; property tests: score in [0,100], monotone (fixing any failing check never lowers a score), blocker cap holds, applicability changes never divide by zero.

Order of the checklist: `priority = severity_rank * (1 + ln(1 + views_28d_affected))`, severity_rank blocker 8, high 4, medium 2, low 1. Items are grouped by check key with the affected listing count ("12 listings have no size chart").

### 10.3 Admin configuration
`listing_quality_config_versions(id, version, weights jsonb, severities jsonb, thresholds jsonb {min_photos, min_resolution_px, payload_budget_kb, ar_desc_min_chars, price_trust_min}, alpha_bps, cap_blocker, effective_from, created_by, approved_by)`, effective-dated and immutable, requester != approver (existing approvals pattern, single approval kind `listing_quality_config`). Zod bounds: weights 0..50, alpha 0..10,000 bps, cap 0..100. Snapshots store the config version used, so a score is reproducible. Changing the config notifies sellers in-app (O10 for notice length).

### 10.4 Impact estimate (honest, A2.13)
Each item shows impact only from real data:
- **Reach**: `views_28d_affected` = the store's own product views of the affected listings (seller-analytics source, already the seller's data). Shown as a number only when the store's own analytics series is releasable under ADR-0045/ADR-0052 rules; otherwise "Not enough data".
- **Effect**: a platform-wide cohort comparison (e.g. size-related return rate of listings with vs without a size chart in the same category) only when each cohort has n >= 50 listings and the 90% interval excludes 0; shown as a range with "estimate" and the cohort size. Otherwise omitted. No figure is invented or extrapolated from external benchmarks (the Zalando 10% figure in spec 10 is context, not a promise to a seller).

### 10.5 Computation
Recomputed incrementally by an outbox consumer on `product.updated|published|unpublished`, `inventory.level_changed`, `price_claim.scored`, `size_chart.validated`, `brand_asset.moderated`, `store_theme.published`, `store.legal_identity_changed`, `listing_quality_config.published`; full nightly recompute per store as a safety net. Writes `listing_quality_snapshots(store_id, product_id, config_version, score, checks jsonb, computed_at)` (latest per product kept + daily history 90 d) and `store_readiness_snapshots(store_id, config_version, srs, catalogue_score, store_checks, items jsonb, computed_at)`. Read path serves the latest snapshot (p95 < 100 ms). Staleness SLO: < 5 min after the triggering event.

### 10.6 Use of the score
v1: display only (seller dashboard, preview side panel, admin store page). It does **not** change ranking, Buy Box or Health Score until owner decision O6; Buy Box neutrality (ADR-0056 hard rule) is unchanged either way.

---

## 11. Permissions (deny by default; store-scoped; foreign store = 404)
New policy resource `store_branding` (permission key `store.branding`) in `packages/policy/src/rules.ts`:
| Action | owner | manager | catalog | warehouse | finance | support |
|---|---|---|---|---|---|---|
| `read` (editor view, history, catalogue, preview, readiness) | yes | yes | yes | yes (preview + readiness only) | yes (preview only) | yes (preview only) |
| `edit_draft` (draft, uploads) | yes | yes | yes | - | - | - |
| `publish` (publish, rollback) | yes | yes | - | - | - | - |

FULL session required (passkey/TOTP, existing); no step-up (no money or PII). Admin roles: trust_safety (asset decisions, disable theme), ops and support (preview with reason code), ops + security (font catalogue). Every write appends to the hash-chained `audit_log` (actor, store, version ids, before/after hash, reason code).

## 12. Flags and kill switches (ADR-0028 polarity: `true` allows, default `false`, errors fail closed)
- `kill.storefront.theming`: false -> every store renders the platform theme; public theme route returns the platform default document; editor read-only with a banner.
- `kill.storefront.fonts`: false -> palette and assets still apply, fonts are platform.
- `kill.storefront.asset_uploads`: false -> uploads refused (`503 uploads_paused`).
- `flag.storefront_theming` (rollout by store cohort), `flag.store_preview`, `flag.listing_readiness`.
- Per-store: restriction `no_custom_theme` (ADR-0056 `store_restrictions`, source `trust_safety`).

## 13. Events
Outbox (same transaction): `store_theme.draft_saved`, `store_theme.published`, `store_theme.rolled_back`, `store_theme.rejected`, `store_theme.disabled_by_platform`, `store_theme.reenabled`, `brand_asset.uploaded`, `brand_asset.moderated(status, reason)`, `brand_asset.revoked`, `store_preview.session_started`, `listing_quality.recomputed(storeId, srs)`, `listing_quality_config.published`. Payloads carry ids, hashes, enums and scores only.
Analytics (Zod-typed, consent-aware): `storefront_editor_opened`, `storefront_contrast_adjustment_shown(accepted)`, `storefront_published(preset_key, entitlement_level)`, `store_preview_opened(...)`, `readiness_fix_clicked(check_key)`, shopper `store_viewed` gains `theme_hash` (for the A/B holdout in 16).

## 14. Failure handling
| Failure | Behaviour |
|---|---|
| Theme route down or slow (> 800 ms) | app uses cached theme, else platform theme; never blocks the store page |
| Font download fails, times out, or hash mismatch | platform fonts this visit; retry next visit with backoff (1 h, 6 h, 24 h); mismatch logged as a security event |
| Asset CDN 404 (revoked) | placeholder fill from palette `surface`; theme recompile on `brand_asset.revoked` |
| Moderation port Unconfigured / queue backlog | asset stays PENDING_REVIEW; draft can be previewed with the pending asset (preview token only), publish blocked; checklist item after SLA |
| Publish transaction fails | nothing changes (pointer move and outbox are one tx); idempotent retry returns the first result |
| Readiness consumer lag | snapshot shows `computed_at`; nightly full recompute; DLQ with replay tool |
| Preview token expired | preview shows "Preview ended" with one-tap renew |
| Entitlement read failure | fallback plan values (fail closed): theme renders at the fallback level, nothing deleted |

## 15. Threat notes (STRIDE; OWASP API Top 10 2023, ASVS 5.0 L2, MASVS)
- **XSS via theme values** (T, API8/ASVS V1): only enums, bounded numbers, `#RRGGBB` and plain short texts; texts rendered as text nodes (never HTML), escaped on web; copy-lint and length caps; no URLs in the document.
- **Style / CSS injection** (T): no raw CSS; web applies validated values with `setProperty`; CSP `style-src` with nonces; native style objects built only from compiled values.
- **SSRF via asset URLs** (API7): there are no seller-supplied URLs; uploads go to presigned PUT on our bucket; workers never fetch external URLs; clients load only from the two allow-listed CDN hosts and refuse any other host.
- **Font file malware / parser exploits** (T, E): no seller font uploads in v1; platform-ingested fonts pass an OpenType sanitizer in an isolated job; immutable content-addressed CDN paths; client verifies SHA-256 before registering.
- **Image parser exploits** (E): SVG/GIF/PDF refused; decode in sandboxed worker with pixel cap; re-encode; AV scan.
- **Honesty bypass** (CPL 181/2018, A2.13): locked components unthemable (lint + contract + visual tests); claims in images or taglines rejected; reserved slots cannot be hidden.
- **Impersonation / IP** (S): pHash against other stores, the restricted-brand list and Z-OUTLET marks; authorization required for restricted marks; takedown revokes.
- **BOLA / BFLA** (API1, API5): store-scoped routes, policy guard + RLS; foreign store 404; role matrix tests for every route; preview tokens limited to an allow-list of GETs.
- **Preview token abuse** (S, I): short TTL, audience-restricted, not refreshable, store-bound; cannot reach writes or other stores; admin previews require reason code and are audited; synthetic personas only.
- **DoS / cost** (API4, D): upload and publish rate limits; document and asset size caps; font budget per store; edge caching of public theme route.
- **Repudiation** (R): every publish, rollback, asset decision, disable and admin preview in the hash-chained audit log.
- **Dark patterns** (spec 18): motion mood cannot exceed kit springs; no themed timers or counters exist to theme.

## 16. Metrics
Product: share of active stores with a published theme (by entitlement level), editor-to-publish rate, contrast suggestions accepted, store page conversion and add-to-bag rate for themed vs a 10% holdout of the same stores rendered with the platform theme (A/B, guardrails below), median SRS and its trend, fix-click to resolved within 7 d, share of listings with a size chart and >= N photos.
SLI/SLO: public theme route p95 < 150 ms (edge), store page first meaningful paint p95 < 1 s warm / 1.5 s cold on 4G, font cache hit rate >= 80% for returning visits, font bytes per session p95 < 1.5 MB, readiness staleness < 5 min, asset review SLA met >= 95%.
Guardrails: crash-free sessions >= 99.8% (unchanged), complaints about misleading stores (target 0), accessibility issue reports, return rate of themed vs holdout stores, CO2e/session image and font bytes (T10).

## 17. Acceptance (Gherkin; become tests)
- Given a draft whose `text` on `background` is 3.1:1, when the seller publishes, then the response is 422 `theme_contrast_failed` listing that pair and a suggested colour; when the seller accepts the suggestion and republishes, then it publishes and every pair in both schemes is >= its threshold.
- Given any published theme (property test over random valid documents), when a product card renders inside the store page, then `PriceBlock`, the verified badge, the "Sponsored" label and the legal identity block are style-identical to the platform render.
- Given a cover image containing "-70%", when T&S (or OCR when configured) reviews it, then it is REJECTED with `asset_contains_claim` and cannot be referenced by a publish.
- Given a theme referencing a font, when the downloaded file's SHA-256 does not match, then the app does not register it, renders platform fonts and records a security event.
- Given a shopper opening a store for the first time with a cold font cache on a slow network, then the header skeleton lasts at most 300 ms and the page renders with platform fonts with no font swap during that visit.
- Given `kill.storefront.theming=false`, then every store page renders the platform theme and the editor is read-only.
- Given a published v3 and a live v4, when the owner rolls back to v3, then v3 is live within the cache TTL, an audit row exists, and v4 is SUPERSEDED, not deleted.
- Given seller A's catalog-role user, when calling `POST /v1/seller/stores/{B}/theme/publish`, then 404 byte-identical to a missing store; on own store, 403 (catalog cannot publish).
- Given a preview token, when calling `POST /v1/cart/lines` or `POST /v1/checkout`, then 403 `preview_read_only`, and no impression or view from the preview appears in seller analytics.
- Given preview with state simulation "verified discount", then the card shows the "Simulation" watermark, and the same product fetched with a shopper token shows only its real state.
- Given a store with 10 live listings, 3 without a size chart (apparel) and legal identity complete, then the checklist lists `size_chart_missing` (3 listings, high) with a deep link to size charts and the SRS equals the formula in 10.2 under config version N.
- Given a missing Arabic title on any live listing, then that listing's LQS <= 49 and the item is severity blocker.
- Given the admin changes `min_photos` from 4 to 5 in a new config version approved by a different admin, then scores recompute within 5 min and each snapshot records the new config version.
- Given a downgrade from `custom_sections` to `branded`, then extra sections stop rendering, the stored document is unchanged, and re-upgrading restores them.
- Given Arabic locale and a curated pairing, then store names render with the Arabic face, no letter-spacing, no uppercase, and the kit Arabic line-height rule; price numerals follow the user's numeral preference in the platform font.

## 18. Work packages (tier per task)
| WP | Scope | Tier |
|---|---|---|
| WP-S0 | Owner decisions O1 to O10; counsel VR-ST-02..05; ADR-0057 acceptance | owner + counsel |
| WP-S1 | Theme document Zod schema, document migrations, compiler, dark derivation, contrast solver (pure, `packages/ui-tokens` + `packages/validation`); signatures and properties first | architect (signatures, properties), builder (implementation), tester (property tests, mutation >= 80% on the solver) |
| WP-S2 | Migrations (`store_themes`, `store_theme_versions`, `brand_assets`, `font_catalog`, `font_pairings`, `theme_presets`, `store_theme_events`, `store_preview_sessions`), RLS, `data_inventory.yaml` tags | builder |
| WP-S3 | API module `storefront` (routes 8.1, publish/rollback transaction, outbox, entitlements reads, restriction `no_custom_theme`) | builder |
| WP-S4 | Asset pipeline worker (sniff, sandboxed decode, AV, re-encode, pHash), `ImageModerationPort` and `ImageTextPort` Unconfigured adapters, admin review queue | builder; security review by architect; chief-reviewer at milestone sign-off (upload attack surface) |
| WP-S5 | Font ingestion tool (OTS sanitize, subset, hash, CDN) + curated catalogue seed after VR-ST-01 | builder; design owner approves families |
| WP-S6 | ui-native `StoreThemeProvider`, locked capsule, reserved card slots, `DS-THEME-LOCKED` lint rule, adversarial-theme contract tests, visual regression | architect (provider API and lint rule), builder, tester |
| WP-S7 | Mobile: theme cache, font loader (VR-ST-06 first), store page sections, in-store cards, PDP band behind entitlement | builder |
| WP-S8 | Seller Center: storefront editor (presets, palette with live contrast meter and suggestions, pairings, shape/density/motion, assets, sections, history, rollback) AR/EN, RTL, light/dark | builder |
| WP-S9 | Preview sessions API, gateway allow-list for `store_preview` tokens, analytics exclusion, synthetic personas, state simulation service | architect (token and gateway rule), builder, tester (negative tests) |
| WP-S10 | Web preview: react-native-web spike (VR-ST-07); then (a) or fallback (b) with parity tests; QR "open on my phone" | architect (spike), builder |
| WP-S11 | In-app brand-mode "Preview as customer" container and controls | builder |
| WP-S12 | Readiness engine (pure formula, consumer, nightly recompute, snapshots), seller dashboard panel, admin config page with approval | architect (formula signatures), builder, tester (properties) |
| WP-S13 | Admin console: asset queue, disable/enable theme, inspect as customer, readiness view | builder |
| WP-S14 | Tests: authz matrix rows for every route, Maestro (AR/EN, RTL, preview), Playwright (editor, preview), k6 on the public theme route, a11y checks | tester |
| WP-S15 | Docs: `docs/design-system/storefront-theming.md` (designer guide), threat model file under `docs/security/threat-models/`, runbook for asset takedown | builder |

Suggested order: S1 -> S2/S3 -> S6 -> S7 -> S8 -> S4/S5 (assets and fonts can start in parallel after S2) -> S12 -> S9 -> S11 -> S10 -> S13 -> S14.

## 19. Owner decisions (block acceptance of ADR-0057, not the engineering defaults)
| # | Decision | Default until decided |
|---|---|---|
| O1 | Which plan tier unlocks which storefront entitlement (6) | all stores: `branded`, custom palette, curated fonts, 4 sections, no PDP band, no video, no fixed scheme |
| O2 | Does the theme reach the PDP (brand band) or the store page only | store page only |
| O3 | Allow brand-proprietary font uploads at all (licence proof, sanitizing, cost) | no |
| O4 | Allow fixed light-only or dark-only stores | no (`follow_system`) |
| O5 | Cover video (data, carbon and moderation cost) | no |
| O6 | Does the readiness score affect ranking, Health Score or visibility | display only |
| O7 | Human review of every brand asset at launch (no in-house classifier yet, ADR-0051) vs a smaller sample | every asset human-reviewed |
| O8 | Final curated font families and presets (design and brand sign-off) | platform pairing only until approved |
| O9 | Platform staff may "inspect as customer" any store (support use) | yes, reason code + audit |
| O10 | Notice to sellers before a readiness config change takes effect | in-app notice, effective immediately (display only) |

## 20. VERIFY BEFORE LAUNCH (proposed rows `VR-ST-*` for `docs/compliance/verify-register.md`)
| Id | Item | Owner |
|---|---|---|
| VR-ST-01 | Licence of every curated font family permits embedding in the iOS/Android apps and on the web, and redistribution through our CDN; keep each licence file | Design / Legal |
| VR-ST-02 | Liability and process for seller-uploaded logos and brand marks (trademark, notice-and-takedown); cross-references VR-BM-02 and ADR-0056 D11 | Legal |
| VR-ST-03 | Whether brand styling adjacent to prices could count as misleading presentation under CPL 181/2018, and the exact seller-identity fields and their placement on a branded store page (cross-references register row 7) | Legal |
| VR-ST-04 | App Store review: remotely delivered per-store themes and fonts are data, not executable code; confirm against the guideline text current at submission | Product / Legal |
| VR-ST-05 | Content policy and any consent requirement for imagery of children and other identifiable people in seller marketing assets (PDPL, child-protection rules) | Legal / DPO |
| VR-ST-06 | Engineering: Expo SDK 57 `expo-font` runtime registration of local font files and any limits; confirm against current Expo docs | Mobile |
| VR-ST-07 | Engineering: feasibility of rendering ui-native screens with react-native-web for the Seller Center preview | Architect |
