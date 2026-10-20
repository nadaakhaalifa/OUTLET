# Z-OUTLET Seller Center and Admin Console: current implementation audit (2026-10-15)

Method: codebase read only (no web research; the web-research steps in researcher.md do not apply). Paths are relative to `/Users/nadakhalifa/OUTLET`. "Complete / partial / stub / missing" are my judgements from reading code, specs and status docs; nothing was run in a browser, simulator, or against a real provider (the repo's own status doc says the same, `docs/plan/status-2026-10.md`).

Global caveat from `docs/plan/status-2026-10.md`: all of this is built and unit/contract tested on synthetic data and fakes; production adapters are Unconfigured and fail closed (ADR-0029); seller-web and admin-web have "typecheck and unit tests; Maestro/Playwright harnesses exist" but no recorded browser or device runs.

## 1. Seller onboarding and KYC

### Takeaway
A full, spec-complete brand application flow exists end to end (seller-web `/apply`, mobile `/brand/*`, admin review console, API module `brand-verification`), with local vs global branches, document upload, strong factor (passkey/TOTP), auto-check taxonomy, SLA, dual approval and conflict resolution. The weak points are that every real verification provider (sanctions, trademark, email) is Unconfigured in production, and a second legacy KYC path (`/v1/seller/kyc*`) still exists in the contract.

### Cited findings
- Flow, states and rules: `docs/specs/brand-onboarding.md`. States DRAFT, SUBMITTED, AUTO_CHECKS, IN_REVIEW, NEEDS_INFO, APPROVED, REJECTED, SUSPENDED, WITHDRAWN (also `apps/admin-web/src/api/brand-schemas.ts` line 11). Mapped onto the older `kycMachine`.
- Steps (mobile, `docs/design-system/brand-apply.md`): Type (local/global) > Country (Egypt pinned; global any) > Account (brand name, phone, email, OTP) > Strong factor (passkey else TOTP, recovery codes) > Details (fields generated from `getBrandRequirements`, autosave) > Documents > Website (DNS TXT domain verification) > Review > Status.
- Seller-web equivalents: `apps/seller-web/src/app/apply/page.tsx`, `apply/[id]/page.tsx`, `start/page.tsx` (post-sign-in router: no store goes to application; open checklist goes to `/onboarding`), `onboarding/page.tsx` (post-approval checklist with progress, "ready to publish").
- Documents (spec section 2): pdf/jpg/png, max 10 MB, max 20 docs, sha256 declared and verified, AV scan before reviewer can read. Local EG: commercial register, tax card, signatory national ID (14 digits), ownership proof group (trademark certificate etc.), ETA registration status. Global: company registration extract, signatory ID, trademark or distributor authorization, website domain, optional VAT/tax id. Requirements are data (`brand_requirement_sets`), admin-editable with dual approval.
- Local vs global differences: requirement sets per (kind, country); country not in table is treated as global; global phone prefixes OTP behind flag `brand_onboarding.global_phone_prefixes` (default off, email OTP fallback); signatory age floor 21 for EG, higher of country majority or 21 for global; GLOBAL plus high-risk country or sanctions warn/fail needs a second admin cosign (`adminCosignBrandApplication`, 409 `cosign_same_admin`); store `kind` local|global drives the shopper "Choose your world" tabs.
- Rejection/appeal: cooldown default 30 days (365 for counterfeit/sanctions, no appeal), one appeal within 30 days by a different reviewer; NEEDS_INFO idle 30 days auto-WITHDRAWN with notices at day 14 and 27; decision SLA 5 business days from SUBMITTED, NEEDS_INFO pauses SLA.
- Auto checks (admin-web `brand-schemas.ts` line 69): document_scan, ocr_extract, field_consistency, sanctions_screen, trademark_register, domain_verified, duplicate_brand, signatory_age, iban_name_match, risk_score. Results pass/warn/fail/skipped/error. Fail-closed: a provider error still reaches IN_REVIEW with the check flagged, no auto-decision (spec section 8).
- Admin review UI: `apps/admin-web/src/app/(console)/brand-applications/page.tsx` (queue with filters status, kind, country, assignee, sla_breached; cursor pagination), `brand-applications/mine/page.tsx`, `brand-applications/[id]/page.tsx` (facts, document checklist by requirement code, secure document viewer with reason code and 60 s style hide, auto-check table with risk band low/medium/high at score 30/70, trademark evidence, duplicate-claim side-by-side compare, SLA meter, claim/release, decision approve / needs_info / reject with reason codes, cosign, conflict resolution, trademark lookup). Reason codes (`brand-schemas.ts` line 17): ok, ownership_not_proven, documents_unreadable, documents_inconsistent, identity_mismatch, domain_not_verified, trademark_owner_mismatch, not_a_brand, prohibited_category, counterfeit_confirmed, sanctions_hit, duplicate_claim, incomplete_information, other. Document read reasons: kyc_review, appeal_review, fraud_investigation, legal_request. Keyboard shortcuts component `components/brand-shortcuts.tsx`. Home tiles (unassigned in review, mine, SLA breached, capped at "50+") in `(console)/page.tsx`.
- Admin API ops (`docs/api/openapi.yaml`): `/v1/admin/brand-applications` plus `/{id}`, `claim`, `release`, `decision`, `cosign`, `retry-provisioning`, `documents/{document_id}/read-url`, `trademark-lookup`, `conflict-resolution`. Seller-side: `/v1/seller/applications*`, `/v1/seller/auth/*` (OTP, passkey, TOTP), `/v1/seller/onboarding-checklist`.
- Automation reality: DNS TXT resolver is real (`apps/api/src/modules/brand-verification/adapters/production-adapters.ts`, NodeDnsResolver with SSRF-style name validation); trademark registry, sanctions screening, verification email, and application ownership are `Unconfigured*` classes that throw 503 `provider_not_configured` in production. Module status "composed" in `apps/api/src/production/bindings.ts`. Admin trademark evidence is therefore manual entry/lookup in practice until a provider is contracted.
- Legacy path: `/v1/seller/kyc`, `/kyc/documents`, `/kyc/submit` still in OpenAPI; admin `/v1/admin/sellers/{storeId}/kyc*` and `/v1/admin/kyc/queue` (used by admin `/sellers` page and `view-models/kyc.ts`) are the older KYC queue. Spec calls it "legacy, see gaps".
- Mobile gaps (`docs/design-system/brand-apply.md`): no native passkey module (real passkey enrol/assert is a stub, TOTP fallback); no QR renderer; seller tokens in memory only, so app restart re-verifies phone; legal declaration text is a draft (VERIFY WITH COUNSEL); agreement link not in-app.
- Not built per spec: `GET /v1/admin/me` was a gap at time of writing (VR-AC-01 in status doc still lists it as blocking Admin).

### Inventory table
| Feature | Exists? / where | Completeness | Notes |
|---|---|---|---|
| Local vs global application type | seller-web `/apply`, mobile `/brand/type`, `/brand/country` | complete (UI), partial (backend providers) | requirement sets are data; country allow-list gated by flag |
| Account creation (phone/email OTP) | seller-web `SellerAuthFlow.tsx`, mobile `/brand/account` | complete | OTP provider real adapter not bound (ADR-0034) |
| Strong factor passkey/TOTP | seller-web `SellerAuthFlow.tsx`, `lib/qr.ts`; mobile `factor.tsx` | complete web, partial mobile | mobile passkey stub |
| Requirements-driven detail form | `view-models/application-form.ts`, `DynamicForm.tsx` | complete | fields as data, autosave |
| Document upload (signed URL, sha256, confirm, delete) | `components/Uploads.tsx`, `actions-onboarding.ts`, mobile `documents.tsx` | complete | AV/OCR providers fake or unconfigured |
| Domain ownership (DNS TXT) | API NodeDnsResolver; web/mobile website step | complete | rate limit 20/h |
| Auto checks (10 codes) | API service; admin detail page | partial | sanctions, trademark, email Unconfigured |
| Admin queue, claim, decide, cosign, conflicts | admin-web brand-applications | complete | needs `GET /v1/admin/me` for real role filtering (VR-AC-01) |
| Reason codes + applicant message AR/EN | `brand-schemas.ts`, `brand-labels.ts`, `i18n` | complete | |
| SLA (5 business days) with server clock | `view-models/brand-review.ts` slaView, Meter | complete | |
| Applicant status/appeal/resubmit | seller-web `apply/[id]`, `view-models/application-status.ts`, mobile `status.tsx` | complete | |
| Store provisioning on approve | API outbox consumer + admin `retry-provisioning` | complete (fakes) | |
| Seller bank (IBAN) verification | seller-web `settings/payout`, `view-models/iban.ts`; admin check `iban_name_match` | partial | name-match provider; 48 h hold on new IBAN |
| Tax/ETA enrolment | seller-web `settings/eta`; API `eta-enrolment` | partial | credentials/HSM delegation = VERIFY (B4) |
| Reviewer SLA reporting / QA / productivity metrics | none | missing | only queue tiles |
| Bulk actions in review queue | none | missing | per-application only |

### Inferences
- Review is manual-first with machine-assisted evidence; the human decision is always required (no auto-approve path), consistent with spec section 8 fail-closed.
- Time-to-approve is dominated by providers not yet contracted, not by UI.

### Gaps
- Real verification-provider latency/accuracy unknown (no provider bound).
- No evidence of queue-throughput features (batching, saved views, assignment rules) beyond filters.

## 2. Seller account and team

### Takeaway
Roles, invitations (by phone), passkey/TOTP and store profile exist and are tested, but there are two parallel team UIs and two API paths, and role/MFA nuance is partly unresolved.

### Cited findings
- Roles in nav (`apps/seller-web/src/view-models/nav.ts`): owner, manager, fulfilment, catalog, finance. Nav is role-filtered but only a convenience (API enforces).
- Team v1: `apps/seller-web/src/app/team/page.tsx`, invite by email to `POST /v1/seller/team`, shows MFA missing pill (`team.mfaWarning`), remove. Team v2: `app/settings/team/page.tsx`, invite by phone via `/v1/seller/stores/{id}/team/invites`, change role, revoke pending invite, last-owner protection, owner-only mutations; accept/decline routes `/v1/seller/team-invites/accept|decline`.
- Auth: OTP + passkey register/assert, TOTP enrol/confirm/assert, sessions list/revoke API (`/v1/seller/auth/sessions*`) but no seller-web UI calling it (grep shows 0 uses).
- Store profile: `settings/profile` (Arabic name required, English optional, descriptions, logo/cover upload via signed URL with confirm), `settings/delivery` (free-delivery threshold, vacation up to 90 days), `settings/shipping` (origin address governorate/city/street/landmark/contact, handling hours 12 to 168, packaging options), `settings/returns`, `settings/notifications` (new order and SLA warnings locked on), `settings/payout`, `settings/eta`. Backend spec `docs/specs/seller-settings.md`; optimistic concurrency via `expectedVersion`.
- Storefront preview API `GET /v1/seller/stores/{storeId}/storefront-preview` exists; seller-web has no page using it (0 grep hits).
- `/settings` root page (`app/settings/page.tsx`) is a read-only summary (store, KYC state, legal identity, thresholds, SLA, health) plus language and sign out.

### Inventory table
| Feature | Where | Completeness | Notes |
|---|---|---|---|
| Role model (5 roles) | `nav.ts`, API policy | complete | |
| Invitations | `/settings/team` (phone), `/team` (email legacy) | partial | duplicated UIs, divergent identifiers |
| MFA enforcement visibility | `/team` pill, `team.mfaWarning` | partial | spec says mandatory passkey/TOTP |
| Passkey/TOTP login | `SellerAuthFlow.tsx` | complete | real authenticator untested (`seller-center-web.md` Gaps) |
| Session/device management | API only | missing in UI | |
| Store profile + media | `/settings/profile` | complete | |
| Vacation mode, threshold | `/settings/delivery` | complete | |
| Shipping origin/handling | `/settings/shipping` | complete | map pin entered as lat/lng text |
| Return policy | `/settings/returns` | complete | statutory 14/30 minimum |
| Notification prefs | `/settings/notifications` | complete | |
| Storefront preview | API only | missing in UI | |
| Granular permissions / custom roles | none | missing | fixed 5 roles |
| Audit log of seller team actions visible to seller | none found | missing | |

### Inferences
- Seller-web "phase 1" pages (`/team`, `/settings` summary) predate the onboarding/settings wave and were not retired.

### Gaps
- Role resolution: spec lists "Role unknown (VR-SC-01)"; `GET /v1/seller/me` now exists but whether nav now uses it was not verified end to end.

## 3. Catalog and inventory

### Takeaway
Catalog list is read-only; create exists but is a crude form without photos or category pickers; CSV import is client-side pre-check only (no upload, no server dry run). The API is richer than the UI. Stock adjustment, low-stock alerts and stock history are not exposed anywhere in seller-web.

### Cited findings
- List: `apps/seller-web/src/app/catalog/page.tsx` shows title, status, department, price, stock, claim. No row actions, filters, search, or bulk select. Pager only.
- Create: `app/catalog/new/page.tsx` renders `components/ProductEditor.tsx` (Arabic title/description required, English optional, category as free-text id field, condition, department, SKU rows with size label, price, stock) and `SizeChartEditor.tsx`. File comment: photo upload not collectable, "a minor-defect product cannot be submitted". `docs/specs/seller-center-web.md` Gaps: "no product edit page (create and status only); no size chart attach to product; no promotion create form; no statement PDF download; no CSV export of analytics; no date range picker."
- Status change only (`PATCH /v1/seller/products/{id}` with `status`): in `api/client.ts` line ~155, but no UI surfaced on the catalog table.
- CSV import: `app/catalog/import/page.tsx` + `components/CsvChecker.tsx`, "Nothing is uploaded from here". `view-models/csv-import.ts`: 6 required columns (title_ar, title_en, category_id, condition, size_label, price_piastres), 6 optional (description_ar, stock, seller_sku, barcode_gtin, color, department), max 5000 rows, error codes per row/column. Client methods `createCatalogImport(uploadId, dryRun)` and `getCatalogImport` exist in `api/client.ts` lines 162-164 but no code calls them (grep). API endpoints `/v1/seller/catalog/imports` exist. E2E test name "csv dry-run reports row errors" is client-side.
- Price and stock endpoints exist: `PUT /v1/seller/skus/{skuId}/stock`, `/price` (spec `inventory.md`: set or adjust, versioned, idempotent, oversell record when below committed). No seller-web use (grep "skus/" = 0).
- Inventory module (row-per-unit, SKIP LOCKED): `apps/api/src/modules/inventory`; no low-stock or stock-history code found in inventory/catalog modules (grep returned nothing); spec out-of-scope list names "the seller bulk endpoint".
- Size charts: list/create in client (`/v1/seller/size-charts`), editor UI present; monotonic validation per spec A2/10; size-demand API `/v1/seller/size-demand`; no attach-to-product in web.
- Channel sync: `/channels` (OAuth Shopify/Woo style) and `/hub`; `view-models/channels.ts`, `store-channels.ts`; Odoo module partial and dark (`bindings.ts` line 31: egress proxy and secrets manager Unconfigured). Product media cut-outs: `/media` (background cleanup jobs accept/use-original/rerun), `view-models/product-media.ts`.
- Mobile brand-mode has the richer product form: multi-photo bulk upload with progress, cover/reorder, condition + defect photos, GTIN check digit, autosave drafts every 1.5 s, publish gate listing what is missing (`docs/design-system/brand-mode.md`), but `api-client-gap.md` says category list and upload were gaps ("`categories()` and `uploadPhotos()` unsupported in API mode") before `listSellerCategories` landed.
- Master prompt section 19 promises: bulk CSV (validated, dry-run, error report), bulk images with background cleanup, AI bilingual titles/descriptions, variants, barcodes, structured size charts, condition/defects, channel integrations (Shopify, WooCommerce, Odoo P3, Google Sheets). No Google Sheets integration found.

### Inventory table
| Feature | Where | Completeness | Notes |
|---|---|---|---|
| Product list | `/catalog` | partial | read-only, no search/filter/bulk |
| Create product | `/catalog/new` | partial | no photos, free-text category id, no variants beyond size rows |
| Edit product | API PATCH; mobile form | missing (web) | |
| Publish/pause/archive | API status PATCH | missing (web UI) | no delete/archive in client |
| Variants (color etc.) | CSV optional `color`; API | partial | size-only in editor |
| Barcodes/GTIN | CSV column; mobile form check digit | partial | |
| Bulk CSV with server dry-run | client pre-check only | stub | server routes exist, unused |
| Bulk image upload | mobile; signed upload APIs | partial | web lacks |
| Size charts | `/catalog/new` SizeChartEditor | partial | no attach, no edit |
| Stock set/adjust | API only | missing (UI) | |
| Stock history, low-stock alerts | none | missing | |
| Channel sync Shopify/Woo | `/channels` | partial | OAuth and fakes |
| Odoo / Google Sheets | Odoo dark; Sheets none | stub / missing | |
| Photo cut-out | `/media` | complete (fakes) | model provider not real |
| AI titles/descriptions | not found in seller-web | missing | `LLM gateway` module exists |
| Markdown suggestion | `/insights`, dashboard aging | complete | "no % off unless verified" notice |

### Gaps
- Whether `ProductEditor`'s server action actually succeeds against the real API (upload ids, category UUIDs) is unverified.

## 4. Orders, returns, payouts, finance

### Takeaway
Order accept/reject/pack, shipment AWB and return inspection are wired with SLA countdowns; finance is read-only statements/payouts/invoices. Disputes, order detail, exports and PDF statements are missing.

### Cited findings
- Orders (`app/orders/page.tsx`, `loaders.ts` `loadOrders`, `view-models/orders.ts`, `components/OrderActions.tsx`): table with id prefix, status, COD/prepaid pill, buyer governorate only (masked PII), lines, subtotal and net-to-seller, server-time accept countdown, role-gated actions accept / reject (reason) / pack / create shipment. Client API: accept, reject, pack, `POST /v1/seller/shipments`, label binary download `GET .../label`. Filter by status exists in client signature (`listOrders(cursor,status)`) but page passes cursor only; no search, no order detail page, no tabs by queue (mobile has queues: to accept, to pack, shipped, returns, done).
- States per master prompt 20.1: PAID, ACCEPTED, PACKED, SHIPPED... plus seller cancel `/v1/seller-orders/{id}/cancel` (no web use).
- Returns (`app/returns/page.tsx`): list with reason, due-by clock, approve/reject buttons; reject hardcodes `reason: "other"` (`hidden={{...reason:"other"}}`), no photos, no dispute view. Statutory silence rule noted (`returns.silence` auto-approve after 48 h).
- Disputes: master prompt 22 says shopper can dispute, T&S review; admin API `/v1/admin/disputes/{id}/resolve` exists; admin-web `returns/page.tsx` shows only refund approvals plus notice `returns.gap`: "The dispute and return list is not available from the Admin API yet." Seller-web has no dispute screen.
- Finance (`app/finance/page.tsx`, `loadFinance`): balance tiles available/pending/held/negative carry; payouts list (period, amount, status); statements (gross, commission, VAT, refunds, net); invoices with ETA UUID. All read-only. No statement PDF/CSV download, no order-level ledger lines, no payout hold reasons or next payout date (also listed as missing in `api-client-gap.md` brand-mode section: "held-payout reasons, next payout date ... not on the wire").
- Reconciliation visible to seller: none (admin only: `(console)/finance/page.tsx` trial balance, reconciliation breaks with age/escalation, payout approvals from the approvals inbox).
- Promotions: `/marketing` list with pause/resume only; no create form (spec gap). Funding shown as seller% / platform%.
- Q&A and reviews reply: API `/v1/seller/questions`, `/reviews` exist; no seller-web screen (grep hits only i18n).
- Ads: `/ads` campaigns, balance, top-up (PSP `client_action` unhandled), reports. Drops: `/drops` create/schedule/edit items. Resale: `/resale`. Forecasts: `/forecasts`. Price trust: `/price-trust` with claims appeal. Hub: `/hub` uses shopper-scoped tracking endpoint (likely 403 for sellers per `seller-center-web-phase2.md`).

### Inventory table
| Feature | Where | Completeness | Notes |
|---|---|---|---|
| Order list | `/orders` | partial | no filters UI, search, detail |
| Accept/reject/pack | OrderActions | complete | |
| Shipping label (AWB) | client `shipmentLabel` | partial | action to create shipment present; label download usage not confirmed in page |
| Cancellation by seller | API only | missing (UI) | |
| Returns inspection | `/returns` | partial | hardcoded reject reason, no evidence photos |
| Disputes | none | missing | admin list not available either |
| Balance / payouts / statements / invoices | `/finance` | partial | read-only |
| Payout bank account + history | `/settings/payout` | complete | |
| Statement PDF/CSV export | none | missing | analytics export API exists, unused |
| Seller-visible reconciliation | none | missing | |
| Promotions create/edit | none (list only) | partial | |
| Q&A, review replies | none | missing | |

## 5. Analytics

### Takeaway
Seller analytics is honest and k-anonymised but narrow: one dashboard (6 tiles, funnel, traffic, geography, aging) and an insights page (markdown, size curve) over a fixed last-30-days window with no range picker and no export in UI. Admin-web has operational queues and a DORA loader, but no business KPI dashboard.

### Cited findings
- Seller dashboard (`app/dashboard/page.tsx`, `view-models/analytics.ts`): tiles GMV, net, orders, units, AOV, repeat rate (null shown as "Not enough data", never 0); freshness banner against SLO (default 15 min per spec); funnel stages with step conversion; traffic by source; geography by governorate with orders and GMV; aging alerts with markdown suggestion + "no % off unless verified" notice. Range: `defaultRange` = last 30 whole UTC days, fixed. k-anonymity min shown, suppressed cell counts only.
- Insights (`app/insights/page.tsx`, `loaders-phase2.ts`): markdown recommendation table (sku, severity, age, on hand, sell-through, price, suggested), size-curve by product (sold share vs stocked share gap), stylist inclusion card says not available.
- Other analytical screens: `/forecasts` (quantile ranges, stale flag), `/price-trust` (score, claims, parity), `/ads` reports (ROAS/CPC/CTR).
- Data source: API `seller-analytics` module (Kysely store over source events in OLTP Postgres; spec says ClickHouse serving is out of scope for v1, markdown "clear 80% in 7 days" elasticity out of scope for v1; `docs/specs/seller-analytics.md` Gaps). `impression`, per-store `checkout`/`purchase` events and `stock_snapshot` must be published by other modules (spec follow-ups), so funnel top stages may be thin.
- API endpoints present but unused in seller-web: `analytics/search-terms`, `analytics/sell-through`, `analytics/returns`, `analytics/exports` (watermarked CSV, owner/manager, audited), `/v1/seller/analytics/summary`, `/v1/seller/stylist/inclusion` (per phase 2 spec "no seller endpoint exists" but path is in OpenAPI; verify).
- Not present anywhere: scheduled reports, alerts, customer demographics (not collected), carbon (P2), voucher ROI, rank position/category percentiles, new vs returning split (only repeat rate), cohort views.
- Admin-web analytics: home page is link list + brand queue tiles; `(console)/engineering/page.tsx` DORA loader (file upload of JSON, proxy flagged) and cost placeholders rendered as "Not measured" (`NOT_MEASURED_PLACEHOLDERS`); `(console)/finance` trial balance; `(console)/ranking` shadow evaluation; `(console)/ads`, `(console)/creators`, `(console)/rewards`, `(console)/plus` (metrics noted as not available). Master prompt 23 promises GMV, take rate, contribution margin, cohorts, conversion, mega-event war room: none built. `docs/specs/admin-console-web-phase2.md` gap 1 lists missing read endpoints for Plus churn, drop queue depth, bot rate, crawler incidents, invalid-traffic queue.
- No fabricated numbers found: components use "Not measured"/"Not enough data" and design notes forbid sample rows (`docs/design-system/admin-console.md` Content rules).

### Inventory table (seller)
| Widget / page | Data source | Completeness | Notes |
|---|---|---|---|
| Sales tiles (6) | `/analytics/sales` | complete | fixed 30d |
| Funnel | `/analytics/funnel` | partial | depends on event publishers |
| Traffic by source | `/analytics/traffic` | complete | k-anon |
| Geography | `/analytics/geography` | complete | governorate |
| Aging + markdown | `/analytics/aging` | complete | |
| Size curve | `/analytics/size-curve` | complete | |
| Forecasts | `/forecasts` | complete (fakes) | |
| Price trust | `/price-trust` | complete | |
| Search terms, sell-through, returns analytics | API only | missing (UI) | |
| CSV export | API only | missing (UI) | |
| Date range picker, compare periods | none | missing | |
| Scheduled reports / alerts | none | missing | |

### Inventory table (admin)
| Widget / page | Completeness | Notes |
|---|---|---|
| Home (links + brand-queue tiles) | partial | no KPI |
| Engineering/DORA | partial | file-loader, proxy metrics, cost "not measured" |
| Finance trial balance + breaks | partial | capped at 200 accounts, "balanced (partial)" flag |
| GMV/take rate/margin/cohorts/war room | missing | |

## 6. Admin Console (pages, RBAC, approvals, audit, DPO, kill switches)

### Takeaway
A broad ops console exists (about 28 routes) with RBAC-filtered nav, dual-approval inbox, JIT elevation, PII-view logging with reasons, DPO console and kill switches. Several screens are read-only because APIs or approval designs are missing, and there is no seller 360 / catalog / orders / user-support tooling.

### Cited findings
Routes in `apps/admin-web/src/app/(console)/`: `/` home, `approvals`, `elevation`, `sellers`, `brand-applications` (+`mine`, `[id]`), `suspensions`, `price-integrity`, `price-matching`, `flags` (kill switches), `privacy` (DPO), `pii`, `tax`, `finance`, `returns`, `promotions`, `plus`, `gift-cards`, `rewards`, `calendar`, `drops`, `ads`, `resale-hub`, `engineering`, `moderation`, `creators`, `ranking`. Nav roles in `view-models/nav.ts`: ops, finance, trust_safety, support, marketing, dpo, security, super_admin.
- RBAC: nav filter only (docs: "hiding is a convenience"); real enforcement is API. If `GET /v1/admin/me` returns nothing, nav shows everything and sensitive writes are disabled (posture unknown); status doc lists VR-AC-01 as a blocker.
- Dual approval: `(console)/approvals/page.tsx` with actionable/waiting/decided, binding-to-subject check (`coversNow`), expiry, "blocked" reasons, approve/reject disabled when posture says writes off. Used for payouts, refunds, gift-card void, creator payouts.
- JIT elevation: `(console)/elevation`. PII viewer: `components/pii-viewer.tsx` (reason code, auto-hide 60 s) and `(console)/pii`.
- Audit log: API `/v1/admin/audit-log` exists; no admin-web page or client method uses it (grep of client paths). Immutable audit in master prompt 23 is therefore not browsable.
- DPO console: `(console)/privacy`: DSAR queue with clocks and blockers, breach register with 72 h PDPC and 3-day subject clocks and triage/step actions. Consent stats, transfer register (spec B1) not present.
- Kill switches: `(console)/flags` + `view-models/killswitch.ts` (265 lines): Allowed/Blocked text badges, reason dialog; e2e test checks all switches render.
- Sellers: `(console)/sellers/page.tsx` is a KYC queue with suspend/reinstate and a reason code dialog; `suspensions` has the 5-business-day review queue with uphold/reinstate and "cannot review own suspension" enforced by API 403. No seller detail/360 (orders, payouts, price trust, health, commission rate), no commission/fee configuration UI, no seller search.
- Catalog/order/user tooling: none. API has `GET /v1/admin/order-groups/{id}` and `/disputes/{id}/resolve`, `/refunds/{id}/approval`, `/finance/payouts*` (approve/hold/cancel), `/finance/reconciliation/*`, `/tax/categories*`, `/home-banners*`, `/price-integrity/config`, `/audit-log`: admin-web client does not call these (path inventory of `api/client.ts` and `server/*.ts`). Home-banner merchandising is API-only.
- Read-only by design: promotions (PATCH needs If-Match), ads config, price tau change (`docs/specs/admin-console-web.md` gaps 3, phase2 gap 3).
- Stub-like: `/returns` is just a refund-approval list with an explicit "not available" notice; `engineering` costs "Not measured".
- Tests: `apps/admin-web/src/view-models/*.test.ts` (brand-review 354 lines, vm, phase2, phase3, meter), `api/client.test.ts`, `session`, `security/csp.test.ts`, `boundaries.test.ts`, `i18n.test.ts`, `app/styles.test.ts`; Playwright `tooling/e2e/tests/admin.spec.ts` (sign-in, each page loads, kill switches, creator payouts disabled while blocked, DORA sample).

### Inventory table
| Capability | Where | Completeness | Notes |
|---|---|---|---|
| Role-filtered nav | `nav.ts` | complete | depends on `/v1/admin/me` |
| Dual approval inbox | `/approvals` | complete | |
| JIT elevation | `/elevation` | complete | |
| PII access with reason | `/pii`, pii-viewer | complete | |
| Audit log viewer | none | missing | API exists |
| DPO: DSAR + breach | `/privacy` | complete | consent stats/transfer register missing |
| Kill switches/flags | `/flags` | complete | |
| Seller suspend/review | `/sellers`, `/suspensions` | complete | |
| Seller 360, commission config | none | missing | |
| Orders/disputes/refunds search | `/returns` stub | stub | |
| Finance: trial balance, breaks, payout approvals | `/finance` | partial | no payout hold/approve screen of its own, no recon summary/runs/files |
| Tax/ETA queue + reconciliation + requeue | `/tax` | complete | exemption admin missing |
| Price integrity monitor | `/price-integrity`, `/price-matching` | partial | config read-mostly |
| Merchandising/homepage builder | none | missing | home-banners API only |
| Support desk / WhatsApp inbox | none | missing | |
| Users and segments | none | missing | |
| Moderation | `/moderation` | partial | publish/reject only |

## 7. Mobile brand mode vs Seller Center

### Takeaway
Two parallel seller surfaces with overlapping core flows and separate adapters; mobile is narrower (dashboard, products, orders, store) but richer in product-photo UX and queue organisation; the web has breadth (ads, drops, finance, channels, media, forecasts). Divergences are partly forced by missing API operations.

### Cited findings
- Mobile brand mode (`apps/mobile/src/features/brand-mode`, `docs/design-system/brand-mode.md`): tabs Dashboard, Products, Orders, Store. Dashboard: sales/orders today, awaiting-accept SLA countdown, low stock, payout summary, price trust, store health. Store: profile, return policy, shipping, vacation, IBAN with step-up, team invite by phone, notification prefs, link to Seller Center. `ApiBrandPort` calls only a subset of operations; unsupported ones point to the Seller Center.
- Mobile-only: low-stock list on dashboard (web has none), order queues (to accept/to pack/shipped/returns/done), camera and multi-photo, draft autosave, publish gate.
- Web-only: finance statements/invoices, ads, drops, resale, forecasts, channels, media cut-outs, analytics funnel/traffic/geography, insights, CSV checker, promotions list, size-chart editor.
- Duplicated: onboarding/application (mobile `/brand/*` vs web `/apply/*`), product create, team invites, profile/shipping/payout settings, order accept/reject/pack. They share the OpenAPI contract but not code; contract gaps and wire mapping are duplicated (`api-client-gap.md` brand mode section; mobile `wire-map.ts` vs web `view-models/application-form.ts`).
- Divergent behaviours noted: mobile ready-for-pickup unsupported (no backend transition route); AWB label download not wired on mobile; dashboard shows "Not enough data" for held-payout reasons, next payout date, store health, dispatch/cancellation rates because they are not on the wire; mobile seller tokens in memory only; mobile passkey stub vs web WebAuthn.
- Dashboard data difference: mobile uses `/v1/seller/analytics/summary`, web uses per-store `/analytics/sales` etc.

## 8. Quality: tests, authorization, Arabic/RTL, known gaps

### Cited findings
- Seller-web tests: `src/test/{onboarding,phase2,view-models,loaders,client,product-media,csp,boundaries}.test.ts`, `view-models/phase3.test.ts`, `styles/tokens-css.test.ts`, `i18n.test.ts`, `lib/format.test.ts` (24 test files across both apps). Playwright `tooling/e2e/tests/seller.spec.ts` covers login, each page in AR and EN, forecasts, cut-outs, k-anon suppression, product editor requires Arabic title, CSV dry-run row errors, orders countdown.
- Authorization: `docs/security/authz-matrix.md` (2026-10-12): 504 OpenAPI operations, 462 implemented, 42 not implemented, 464 of 464 registered routes covered (65 with full shared-harness cases, 399 delegated to per-module suites plus central 401/authz-mode/OpenAPI checks). Seller-web/admin-web themselves rely on API 403/404 and `boundaries.test.ts` import rules.
- Arabic/RTL: Arabic default, logical CSS only, Eastern Arabic numerals in `ar`, id/code fields `dir=ltr`; `ar.ts` typed `Record<MessageKey,string>` so missing keys fail the build; placeholder parity tests; CI i18n-check. Not verified in a real browser or with a screen reader (`seller-center-web.md` Not verified; admin spec gap 5); design notes record that the `border` token contrast is only about 1.4:1, so control outlines use `textSecondary`.
- Known gaps list in status doc: Admin needs `GET /v1/admin/me` (VR-AC-01); no simulator/device runs; GitHub Actions never run; Stryker not re-run on latest tests; no pen test.
- Seller-web `fast-check` undeclared in package.json (spec gap); SRI not generated; passkey flow untested with a real authenticator; admin passkey endpoints not admin-audience and DeviceInfo.platform lacks `web` (admin spec gap 2, may be resolved since; not re-verified).
- Fragmentation signal: two API clients in seller-web (`api/client.ts` legacy, `api/onboarding-client.ts` newer) and two schema sets.

### Gaps
- Actual test pass/fail state not re-run for this audit.
- Accessibility (axe) results not available.

## 9. Prioritised gaps (for the marketplace-dashboard gap analysis)

1. Catalog management is not usable at seller scale on web: no edit, archive/delete, search/filter, bulk actions, photo upload, category picker; CSV import never reaches the server (dry-run API exists unused). (`app/catalog/*`, `api/client.ts` 162-164)
2. Inventory operations absent from UI and backend: no stock adjust screen, stock history, low-stock alerts, or bulk stock update (API `PUT /v1/seller/skus/{id}/stock` unused; no history in inventory module).
3. No dispute/case management on either side: seller returns reject uses hardcoded reason `other`, no evidence; admin returns/disputes list "not available from the Admin API".
4. Analytics depth: fixed 30-day window, no date range/compare, no export/scheduled reports in UI despite export API, search terms/sell-through/returns analytics unused; admin has no business KPI dashboard (GMV, take rate, margin, cohorts, war room).
5. Finance transparency: read-only; no PDF/CSV statements, no payout hold reasons or next payout date on wire, no order-level earnings drill-down, no seller reconciliation view.
6. Order operations: no order detail page, queue tabs, bulk print labels/pack, search, seller-initiated cancel UI, or ready-for-pickup transition (no backend route).
7. Admin tooling gaps: no seller 360/commission settings, no audit-log viewer, no order/user lookup, no support desk, no merchandising (home-banners API-only), several screens read-only (promotions, ads config); `GET /v1/admin/me` dependency for RBAC posture.
8. Verification automation depends on unconfigured providers (sanctions, trademark, email); manual review will dominate until contracted; no reviewer productivity/SLA reporting or bulk review.
9. Duplicated surfaces and legacy remnants: two team UIs and clients, legacy `/v1/seller/kyc`, web vs mobile divergent flows; mobile passkey stub.
10. Engagement features: no Q&A/review reply UI (APIs exist), no notifications centre/inbox for sellers, no storefront preview UI, no session/device management UI, no promotion create form.
11. Quality evidence: no browser/device runs, no recorded a11y or RTL review, nothing executed on CI or real providers.

## Source index
Specs and docs: `CLAUDE.md`; `docs/haul-master-prompt-v3.md` sections 9, 15.6, 19, 19.1, 22, 23, B4, B5, T4; `docs/plan/status-2026-10.md`; `docs/plan/api-client-gap.md`; `docs/design-system/{seller-center,seller-center-phase2,admin-console,admin-console-phase2,brand-mode,brand-apply}.md`; `docs/specs/{brand-onboarding,seller-center-web,seller-center-web-phase2,seller-analytics,seller-settings,inventory,admin-console-web,admin-console-web-phase2,admin-brand-review-web}.md`; `docs/api/openapi.yaml`; `docs/security/authz-matrix.md`.
Code: `apps/seller-web/src/{app,api,view-models,components,loaders*.ts,test}`; `apps/admin-web/src/{app/(console),api,view-models,server,components}`; `apps/mobile/src/features/{brand-mode,brand-apply}`, `apps/mobile/src/app/{brand,brand-mode}`; `apps/api/src/modules/{brand-verification,seller-analytics,seller-settings,inventory,catalog}`; `apps/api/src/production/bindings.ts`; `tooling/e2e/tests/{seller,admin}.spec.ts`.

Caveats: "unused API" claims come from grep of seller-web/admin-web source for the path string; a call built dynamically could be missed. Seller team-invite `email` vs `phone` divergence and `/v1/seller/stylist/inclusion` status were noted from specs, not exercised.
