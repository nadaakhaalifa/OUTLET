# Architecture decision records (ADRs)

Outlex (working name; code name Outlet NK). Format: MADR (Status, Context, Options considered, Decision, Consequences, Verify-register rows, Related).

Order of precedence when documents conflict: owner's latest words → `docs/BUILD-PROMPT.md` → `docs/outlet-nk-vision-addendum.md` → `docs/haul-master-prompt-v3.md` (where it says HAUL, read Outlex).

**"Proposed — owner accepted"** means the owner accepted the recommendation on 2026-11-07 ("do whatever is best") as a working default. It still needs counsel or contract confirmation before anything real: no real money, no real personal data, no cloud provisioning.

| ADR | Title | Status | Decision in one line | Owner decisions it depends on |
|---|---|---|---|---|
| [0001](0001-architecture.md) | Architecture | Proposed — owner accepted | Web-first hexagonal modular monolith: Next.js (`[market]-[locale]`), NestJS, Postgres 16 + PgBouncer, Redis never truth, BullMQ, Cloudflare edge; sized for 4M users; dependency-cruiser fitness functions | D0, D4, D6 |
| [0002](0002-data-residency.md) | Data residency | Proposed — owner accepted; **no provisioning without owner approval** | Hybrid cells: personal and money data in Egypt (Huawei Cloud Cairo after a 1-week spike, AWS me-central-1 fallback); P0 catalog on the global edge | D4 |
| [0003](0003-wallet-store-credit.md) | Wallet = store credit; seller money flow | Proposed — owner accepted | Closed-loop credit (no top-up, no cash-out); one ledger with a `SettlementPort` that supports PSP split or merchant-collects-then-pays-out, chosen after PSP + counsel answers | D5 |
| [0004](0004-plus-billing-app-store.md) | Plus billing and app stores | Proposed — owner accepted | Plus is Phase 2, commerce-only, PSP-billed (Plan A) with Plan B designed in; web-first means it sells on the web first; 21+ | Age rule; D2 open |
| [0005](0005-inventory-row-per-unit.md) | Inventory | Proposed | Row-per-unit with `FOR UPDATE SKIP LOCKED`; one-off defect units are single rows linked to their passport | — |
| [0006](0006-global-ready-from-day-one.md) | Global-ready from day one | Proposed | `market_id` everywhere, money = minor units + currency, cells per market; launch Egypt only | — |
| [0007](0007-web-first.md) | Web first | Proposed — owner accepted | Next.js PWA in Phase 1; Expo SDK 57+ Android + iOS together in Phase 2; allow search bots, block AI training bots | D6, D8 |
| [0008](0008-seller-plans-saas.md) | Seller plans (SaaS) | Proposed — owner accepted | Plans, commission (basis points) and entitlements are versioned config; no numbers until D1; display modes public / member-only / hidden | D1, D3 |
| [0009](0009-defect-grading-and-defect-passport.md) | Defect grading and passport | Proposed — owner accepted | Two axes (grade + structured defects), QR passport per unit, separate acknowledgement tick; 14-day returns always apply (safe default, V19) | D6, age rule |
| [0010](0010-search-engine-bake-off.md) | Search engine bake-off | Proposed | Run a weighted bake-off (Typesense, Meilisearch, OpenSearch; Postgres FTS baseline + fallback) on ~500 real AR/EN/Franco queries | — |
| [0011](0011-database-roles-and-rls-contexts.md) | Database roles and RLS contexts | Proposed (chief-review before migration) | Least-privilege roles `outlet_app` / `outlet_auth` / `outlet_worker` / `outlet_migrator`, one PgBouncer pool each; exceptions are role-scoped policies keyed on `SET LOCAL app.ctx` (+ `app.job`); never BYPASSRLS | — |

## Owner decisions referenced
D0 older code is reference only · D1 seller commission/prices open (~15% ceiling) · D2 Plus price open · D3 public verified % by default, brand may choose member-only/hidden · D4 hybrid hosting · D5 payment split open · D6 women's + modest fashion + kids at launch, multi-category-ready taxonomy · D7 "Outlex" working name (V31) · D8 allow search bots, block AI training bots · Age: 18 to shop, 21 for contracts (V8).

## Verify-register numbering
V1–V18 master prompt P2 · V19–V26 vision addendum · V27–V28 Price Watch · V29–V31 ADR-0006 · V32–V36 shipping spec · V37 Huawei Cloud Cairo service catalog · V38 measured latency · V39 encrypted data abroad as a transfer · V40–V52 the build-plan report's other items (renumbered +10) · V53–V58 added by the register sweep · new rows from these ADRs:
- **V66** Google Play payments policy for a PSP-billed commerce-only Plus (ADR-0004)
- **V67** search engine licences for our commercial use (ADR-0010; Arabic support is V47)
- **V68** global CDN/WAF proxying of personal traffic as a transfer (ADR-0002)
- **V69** Egyptian product-safety rules for kids' clothing and accessories (ADR-0009; other categories are V56)

Other existing rows these ADRs also use: V47 Typesense Arabic support, V48 Cloudflare plan pricing, V56 Pantry/cosmetics/electronics rules.

The register itself lives in `docs/compliance/verify-register.md` (task P0-12).
