# Known failures triage, 2026-10-16

Read-only triage. Nothing was fixed. Evidence gathered 2026-10-16 about 15:10-15:30 Cairo, while other builders were still editing (new files appeared during the run, see "Transient" below).

## How "pre-existing" was judged

- The last commit is `23f9ac6` (Sun Oct 11 11:55). Nothing was committed after it, so `git log` and `git blame` cannot date anything newer: every file touched since Oct 11 is uncommitted (1029 entries in `git status`). The evidence used is file mtime/birth time (`stat`), whether the file is untracked, and the content of the code.
- "Today" = mtime on or after 2026-10-16 00:00. A list of 277 such files was taken at about 15:10 (excluding docs/reports). None of the files behind items 1, 2, 3, 4 and 6 is in it: product-media, catalog, payouts, retention, domain/payouts and the 0083-0087 migrations were last modified Oct 11-13 (the newest product-media file is Oct 13 00:18).
- Env note: `node` on PATH is v25.9.0 (`/opt/homebrew/bin`), the repo wants `>=24.3.0`, and `/usr/local/bin/node` is v24.15.0. `depcruise` refuses to run on v25 ("node version 25.9.0 is not supported"), so item 10 was run with `PATH=/usr/local/bin:$PATH`. Anyone running `pnpm depcruise` with the default node gets that refusal rather than a violations list. Separate small finding.

## Per item

### 1. apps/api typecheck + product-media pglite/http/in-memory failures

- Status: STILL FAILING.
  - `cd apps/api && node_modules/.bin/tsc --noEmit -p .` gives 5 errors:
    - `catalog/test/catalog.media-jobs.http.test.ts(30,25)` and `catalog.media-jobs.wiring.test.ts(64,27)`: "missing the following properties from type 'ProductMediaJob': currentVersion, editCount, promotedVersion, backgroundRenderRef".
    - `product-media/application/product-media.ts(27,11)`: same missing properties (the use case builds a `ProductMediaJob` literal without the 4 new fields).
    - `product-media/test/store-contract.ts(9,87)`: `currentVersion` optional vs required.
    - `product-media.controller.ts(203,17)`: item 6.
  - `npx vitest run src/modules/product-media`: 15 failures.
    - pglite (6 of 8): `column "current_version" does not exist`, and `column "refine_units" of relation "product_media_usage" does not exist`.
    - in-memory contract (1): "compare-and-sets on version and enforces the state machine: promise resolved instead of rejecting".
    - http (8 of 12): `expected 400 to be 200` on `POST .../process`, at `product-media.http.test.ts:37`.
- Which migration owns the columns: `0087_product_media_versions.sql` (born Oct 13 00:15) adds `product_media_jobs.current_version / edit_count / promoted_version / background_render_ref` and `product_media_usage.refine_units`. The migration exists and is correct. `kysely-store.pglite.test.ts` (Oct 12 23:20) builds its DB with `createTestDatabaseUpTo(13)` plus only `0083` and `0085`; it never applies `0087`, so the columns do not exist in the test DB. 0083/0085 do not define them. The test predates 0087 by 55 minutes.
- Typecheck errors: `domain/ports.ts` (Oct 13 00:16) added the 4 required fields to `ProductMediaJob`; the literal in `application/product-media.ts` (00:17), `test/store-contract.ts` (Oct 12 23:22) and the two catalog media-jobs tests (23:27 and 00:18) were not updated.
- in-memory contract: `domain/machine.ts` (Oct 13 00:16) now deliberately allows `READY -> PROCESSING` ("entered from a finished job by a manual refine"); `store-contract.ts` (Oct 12 23:22) still asserts that transition rejects.
- http 400s: root cause NOT isolated (I did not edit the test to print the body). It starts at the first `/process` call after a successful `/uploads` 201, and every `process`-dependent test fails the same way. Likely the same unfinished refine/versions change set (Oct 13 00:16-00:18), probably the job literal or process path; needs the response body.
- Pre-existing: YES. Files untracked or modified Oct 12 21:41 to Oct 13 00:18; nothing here modified on Oct 16.
- Owner area: product-media (background removal, refine/versions work of Oct 12-13), with catalog media-jobs tests.
- Smallest fix:
  - Add `await raw.exec(read("0087_product_media_versions.sql"))` after 0085 in `kysely-store.pglite.test.ts`.
  - Add `currentVersion: 0, editCount: 0, promotedVersion: 0, backgroundRenderRef: null` to the job literals in `product-media.ts`, `store-contract.ts` `job()`, and the two catalog tests.
  - Update the contract assertion to the new machine (READY -> PROCESSING allowed; assert some still-invalid transition, for example FAILED -> READY).
  - Print `run.body` for the 400 and fix.
- Blocks Phase A gate: YES (typecheck red, 15 tests red).

### 2. catalog-wishlists.pglite.test.ts title_en_missing

- Status: STILL FAILING. `npx vitest run src/production/catalog-wishlists.pglite.test.ts`: 6 of 11 fail. First error: `422 catalog_validation_failed ... errors:[{"pointer":"/title/en","code":"title_en_missing"}]`, from `createAndPublish` (line 112, the `PATCH status:active`).
- Cause: the test fixture posts `title: {ar: ...}` and `description: {ar: ...}` only. `packages/domain/src/catalog/listing.ts` and `names.ts` (both Oct 13 00:12) made a missing English title a blocking publish issue (`publishWarnings`: `title_en_missing` blocking true). The test file is Oct 11 12:35.
- Pre-existing: YES (domain change Oct 13 00:12, test Oct 11).
- Owner: catalog (bilingual title rule), production composition test.
- Smallest fix: add `title.en` and `description.en` to the create body in `createAndPublish`. The same applies to any other fixture that publishes with Arabic only (`catalog.http.test.ts` and `taxonomy-bilingual.test.ts` were updated Oct 13 00:17-00:18 and pass).
- Blocks: YES.

### 3. payouts R-5 and retention ctid pglite tests

Both are wall-clock time bombs, not logic regressions. Both files are from Oct 10-11 and passed when written.

- **Payouts R-5**: `npx vitest run src/modules/payouts/adapters/kysely-store.pglite.test.ts`: 1 failed of 40. `R-5: sweeper resumes a stale APPROVED payout ...` gives `expected { reversed: +0, resumed: +0 } to deeply equal { reversed: +0, resumed: 1 }`.
  - Cause: `test/fixtures.ts` (Oct 11 02:04) has `T0 = Date.UTC(2026, 9, 14, 12, 0, 0)` (Oct 14 12:00) as the TestClock start. `recoverOrphanEntries` compares `clock.now - payout.updatedAtMs`, but `updated_at` is set by the database (`touch_updated_at` trigger and `DEFAULT now()`, migration 0035), i.e. real wall-clock time. Once the real date passed Oct 14 12:00, `updated_at` (real now, about Oct 16) is later than the test clock (T0 + 11 min), the age is negative, and the payout is never "stale".
  - Pre-existing: YES (code Oct 11; trips only because real time passed T0 on Oct 14).
  - Smallest fix: make `T0` real time (for example `Date.now()` captured once), or advance the clock past the DB's now, or have the store take `updated_at` from the clock. It will keep failing for any fixed future-dated T0 once the calendar passes it.
- **Retention ctid**: `npx vitest run src/modules/retention/adapters/kysely-store.pglite.test.ts`: 1 failed of 50. `inbox and idempotency keys: ctid batches terminate and respect batch size: expected 2 to be 1` at line 119.
  - Cause: the test pins `NOW = Date.UTC(2026, 9, 11, 1, 0, 0)` (Oct 11) and creates `key(40, -5)` ("still valid", `expires_at = NOW + 5 days = Oct 16 01:00`). The `idempotency.keys` target filters on SQL `t.expires_at < now()`, which is real time. After Oct 16 01:00 that key is expired, so 2 rows purge instead of 1. Test and store are from Oct 11 09:39-09:44.
  - Pre-existing: YES (a time bomb that tripped at 2026-10-16 01:00).
  - Smallest fix: make the "still valid" key expire far in the future (for example `key(40, -400)`), or derive `NOW` from the real clock.
- Owner: payouts and retention test fixtures.
- Blocks: YES (full api suite red) unless the gate excludes these two.

### 4. packages/domain typecheck, payouts.mutation.test.ts

- Status: STILL FAILING. `cd packages/domain && node_modules/.bin/tsc --noEmit -p .`: `src/payouts/payouts.mutation.test.ts(300,37): error TS2322: Type '"PENDING"' is not assignable to type '"EXPIRED" | "REQUESTED" | "APPROVED" | "REJECTED" | undefined'`.
- Evidence: file is untracked (`??`), mtime Oct 12 19:55; also untracked `stryker.payouts.mjs`. `approval.ts` (Oct 11 01:49, in HEAD) has the state union with `REQUESTED`, not `PENDING`.
- Pre-existing: YES.
- Owner: domain payouts, mutation-testing pass (docs/plan/mutation-status.md).
- Smallest fix: in line 300 replace `state: "PENDING"` with `state: "REQUESTED"` (the intent is a non-APPROVED record). Then re-check the mutation expectations.
- Blocks: YES (typecheck of packages/domain is red).

### 5. check-inventory.mjs

- Status: STILL FAILING, but the error set changed. `node tooling/privacy/check-inventory.mjs`: now about 95 `untagged column` errors across 14 tables.
  - 19 are the pre-existing product-media ones: `product_media_versions` x17, `product_media_jobs.current_version`, `product_media_usage.refine_units`. These match the "19 errors" the builders reported. `docs/privacy/data_inventory.yaml` (Oct 12 23:40) has `product_media_jobs`, `product_media_usage`, `product_media_blob_graveyard` and `product_media`, but nothing for `product_media_versions` and nothing for the two 0087 columns. 0087 was written 35 minutes later than the inventory edit.
  - About 76 are NEW and come from migrations created minutes ago, today 15:13-15:15: `0088_analytics_rollups.sql`, `0089_ledger_integrity_runs.sql`, `0090_analytics_facts_privacy.sql`, `0092_web_sessions.sql`. Tables and columns: `analytics_erased_keys`, `analytics_rollup_reconciliations`, `analytics_rollup_watermarks`, `ledger_integrity_runs`, `ledger_integrity_drift_samples`, `platform_metrics_hourly`, `seller_analytics_facts`, `seller_analytics_hourly`, `seller_analytics_suppression_memo`, `auth_sessions.uv` and `devices.install_secret_hash` (from 0092).
- Pre-existing: YES for the 19 product-media errors (0087 born Oct 13 00:15). NO for the rest (today, dashboard-foundations track).
- Owner: privacy inventory (product-media: media owner; the rest: the dashboard/analytics builder who added 0088-0092).
- Smallest fix: add the 17 `product_media_versions` columns, plus the two columns, with PII class, retention and processor to `data_inventory.yaml` (seller-owned content, keys only, ON DELETE CASCADE from job). The new 0088-0092 tables need their own entries.
- Blocks: YES.

### 6. product-media controller rate-limit dimension 'store'

- Status: STILL FAILING (tsc error `product-media.controller.ts(203,17): Type '"store"' is not assignable to type 'RateLimitDimension'`).
- Evidence: `platform/decorators.ts:50` (Oct 12 21:51): `RateLimitDimension = "ip" | "user" | "device" | "phone" | "challenge"`. Controller line 203: `@RateLimit([{ dimension: "store", limit: 30, windowSeconds: 60 }])` on `refine`, controller mtime Oct 13 00:18. Across `apps/api/src`, `store` appears exactly once (this line); 412 uses of `user`. `rate-limit.guard.ts` (Oct 10) has no store key resolution.
- Pre-existing: YES.
- Smallest fix: change to `dimension: "user"` (seller staff identity is already authenticated; the 30 edits per photo cap and the daily quota already limit per store). Adding a real `store` dimension would need guard key resolution from `:storeId`, which is larger.
- Blocks: YES (part of the typecheck failure in item 1).

### 7. mobile cutout versions list reads raw.versions

- Status: STILL WRONG. The code is in `apps/mobile/src/features/background-removal/api.ts` lines 100-106 (not brand-mode), mtime Oct 13 00:17. `versions()` reads `raw.versions` and `v.links.png.url`, `v.links.white_jpg.url`, and derives `kind` from `version === 1`.
- Contract: controller (`product-media.controller.ts:255`) returns `{ current_version, items: [...] }`, and `docs/api/openapi.yaml` `ProductMediaVersionList` requires `[current_version, items]`. Each item per `packages/api-client/src/generated/schemas.ts:1122` is `{ version, op, quality_score, quality_reasons, created_at, is_current, thumbnail }`. There is no `links` and no `versions`. So today it always returns an empty list (`raw.versions ?? []`).
- Pre-existing: YES (Oct 13 00:17; not in today's list).
- Smallest fix: read `raw.items`; map `op` to kind (`initial` becomes original), `thumbnail?.url` for the cutout URL; update the local `WireVersion` type and the dev sidecar/tests to the same shape. There is no white URL on the list item, so either drop `whiteUrl` there or fetch it on demand.
- Blocks: not a typecheck/test failure (typed as unknown), so it does not turn the gate red by itself, but it is a functional bug in the editor's undo/history. Treat as a must-fix before the editor ships; Phase A gate: NO unless the gate includes behaviour review.

### 8. ui-tokens Latin leading test (offer 1.27 < 1.3)

- Status: STILL FAILING. `cd packages/ui-tokens && npx vitest run`: `native density v2 > Latin leading stays readable ... → offer: expected 1.2727272727272727 to be greater than or equal to 1.3` (1 failed of 102).
- Which token: `nativeTypography.offer` in `src/index.ts` line 250: `fontSize 22, lineHeight 28` (28/22 = 1.273; text face needs 1.3, so lineHeight must be at least 29). The comment says "Offer card headline (Latin lining figures, Inter semibold). Additive." The web-scale `typography.offer` (line 220, 24/30 = 1.25) would also fail the same rule but is not covered by the test.
- Origin: no commit introduced it. HEAD's `src/index.ts` is from the first commit (`4047d41`), which has neither `nativeTypography` nor the density test; the whole density v2 block (and the test) is uncommitted. `index.ts` mtime is today 14:21, `index.test.ts` today 12:40. The `offer` variant already existed on Oct 15 20:49 (`home-banners/PromoBanners.tsx` uses `variant="offer"`), so the token was introduced by Oct 15 at the latest, but I cannot tell whether the current 22/28 values or the new Latin-leading assertion arrived today. Both files were edited today.
- Pre-existing: UNKNOWN. Leaning "today": the failing assertion lives in a test file edited today at 12:40, and the token file was edited at 14:21.
- Owner: design tokens / mobile home banners.
- Smallest fix: `offer.lineHeight` 28 to 29 (and 24/30 to 24/32 on the web scale for consistency), or exempt `offer` explicitly in the test if a tight headline leading is intentional (then record it in density-v2.md).
- Blocks: YES (package test red).

### 9. i18n "no catalog hard-codes a legacy name"

- Status: STILL FAILING. `cd packages/i18n && npx vitest run`: `product name > is Z-OUTLET and no catalog hard-codes a legacy name` fails on the regex `/Z-OUTLET|HAUL|أوتلت/`.
- Key: `worlds.discover.storesBody` in `packages/i18n/src/ar.ts:581`: "كل متاجر الأوتلت في قائمة واحدة" ("every outlet store in one list"). English twin is `en.ts:577` "Every outlet store in one list" (fine: only the Arabic transliteration is banned). The key is used by `apps/mobile/src/features/worlds/WorldsScreen.tsx:90` (mtime Oct 15 16:41).
- Origin: not in HEAD (`git show HEAD:packages/i18n/src/ar.ts | grep -c أوتلت` gives 0). The test file is unchanged since Oct 10 20:11. `ar.ts` was last modified today 14:43, so the exact add time is not provable; the consuming screen was last written Oct 15 16:41, which suggests the key existed by then.
- Pre-existing: LIKELY YES (added by Oct 15 16:41 at the latest by its consumer), UNKNOWN for certain because `ar.ts` was also edited today.
- Owner: mobile worlds / i18n Arabic copy (see `docs/plan/ar-copy-review-2026-10.md`).
- Smallest fix: reword the Arabic string without the banned word, for example "كل المتاجر في قائمة واحدة".
- Blocks: YES.

### 10. pnpm depcruise

- Command: `PATH=/usr/local/bin:$PATH node_modules/.bin/depcruise packages apps --config .dependency-cruiser.cjs --output-type err` (default node v25 refuses to run, see the env note). Result: 11 errors, 4 warnings (the builders saw 10; one more appeared during the session).
- All 11 errors, with birth/mtime:
  1. `not-to-dev-dep`: `apps/admin-web/src/app/spike/recharts-section.tsx` to `recharts` (born/modified today 14:17).
  2-5. `not-to-dev-dep`: `apps/admin-web/src/app/spike/echarts-section.tsx` to `echarts` (renderers, core, components, charts) (born today 14:17, modified 14:44). `recharts` and `echarts` are in admin-web `devDependencies` (package.json lines 28 and 30) while app code imports them.
  6. `no-deep-import-into-shared-package`: `apps/seller-web/src/styles/tokens-css.ts` to `packages/ui-web/src/css-entry.ts` (today 14:18).
  7. `no-deep-import-into-shared-package`: `apps/admin-web/src/app/styles.ts` to `packages/ui-web/src/css-entry.ts` (today 14:18).
  8-10. `no-deep-import-into-shared-package`: `apps/mobile/src/features/stores-directory/egypt-areas.test.ts` to `packages/i18n/src/en.ts`, `packages/i18n/src/ar.ts` and `packages/domain/src/addresses/coverage-data.ts` (test born today 13:53, modified 14:51; `coverage-data.ts` is Oct 11).
  11. `domain-no-io-core-modules`: `apps/api/src/modules/analytics-ingest/domain/events.ts` imports `node:crypto` (file born today 15:14, so this is the newest one and probably the "10 to 11" change).
- Pre-existing: NO for all 11. Every offending file was created or modified today. `.dependency-cruiser.cjs` itself was modified today.
- Owner: dashboard spike (admin-web spike), ui-web css entry (`packages/ui-web` split), mobile stores-directory test, analytics-ingest.
- Smallest fix:
  - Spike: move `echarts` and `recharts` to `dependencies` or exclude `src/app/spike` from the rule (it is a throwaway spike).
  - `css-entry.ts`: export it from `ui-web/src/index.ts` or add a package `exports` entry, and let the rule allow that subpath.
  - egypt-areas test: import via the packages' public index (`@outlet/i18n`, `@outlet/domain`), or add `pathNot` for tests.
  - events.ts: take the hash from an injected port or move it to `application/`/adapter (domain stays pure).
- Blocks: YES.

### 11. tooling/e2e/run.sh admin with E2E_PROD=1: `/_global-error` prerender useContext

- Evidence: `/tmp/e2e-build.log` (Oct 16 15:03). Turbopack build: "Compiled successfully", TypeScript finishes, then at 15/31 static pages: `Error occurred prerendering page "/_global-error" ... TypeError: Cannot read properties of null (reading 'useContext')` and `next build worker exited with code 1`.
- What I checked (no build was run, no servers started; ports 3001-3003, 3917, 3918 were free, no next process was running):
  - `apps/admin-web` has no `next.config.*` file at all, so there is no `distDir`, `output` or `serverExternalPackages` setting involved.
  - There is a single React (19.2.3) and a single `next` instance across admin/seller/shopper (same pnpm path), so a duplicate React or Next copy is not the cause. `NODE_ENV` is unset here and the log has no "non-standard NODE_ENV" warning, so that is not it either.
  - The script differs from a manual build only in: it exports `ADMIN_API_BASE_URL=http://127.0.0.1:3918` before `next build`, it runs with output redirected (non-TTY) and it inherits the caller's whole environment; it runs `next build` in an `apps/admin-web/.next` that a previous `next dev` or other builder may share. `apps/admin-web/.next` exists with files at 15:03.
- Most plausible causes, in order:
  1. A leaked environment variable from the caller. The script inherits everything; the usual source of this exact `/_global-error` + `null.useContext` crash in Next is a non-standard `NODE_ENV` or other React-dev/prod mismatch in the parent shell (Playwright or Vitest sessions often set `NODE_ENV=test`). The 15:03 log does not show the warning, so this is lower than it normally is, but the builder's shell was not captured.
  2. A concurrent writer in `apps/admin-web/.next`: the same builder (or another) running `next dev` or a second `next build` in the same folder while the script builds. The build manifests at 15:03 are mixed with other activity today (spike pages created 14:17, `proxy.ts`, 31 routes).
  3. The newly added `/spike/*` and ECharts/Recharts client code being pulled into a static prerender. Spike pages were born today; the failure happened while 31 static pages were generated. If `/spike/charts` is statically prerendered and recharts or echarts touch a React context at module scope, the error would be reported against a neighbouring page. Cheap test: temporarily build with the spike folder excluded or `export const dynamic = "force-dynamic"` on the spike route.
  4. `ADMIN_API_BASE_URL` set only by the script: a static page (login or a shell layout) that reads `readApiBaseUrl(process.env)` differently when the URL is set. `config.ts` is not modified today, but `client.ts` and `proxy.ts` are; worth one `ADMIN_API_BASE_URL=... next build` against a plain `next build`.
- Pre-existing: UNKNOWN. The script is old, but the spike pages and admin changes (today 14:17-14:44) were added the same afternoon, so a regression from today is plausible.
- Owner: admin-web build / e2e tooling.
- Smallest fix (to try, not applied): run the script with `env -i PATH=... HOME=...` plus the required vars, to rule out inherited env; rebuild with the spike excluded. If both builds pass, the culprit is the env or the concurrent `.next`, and the script should use a dedicated `NEXT_DIST_DIR` or a clean `rm -rf .next` before building, and set `NODE_ENV=production` explicitly.
- Blocks: only if the gate includes the prod-mode admin E2E. Not a correctness failure of the admin app itself.

## Concurrent checks requested

Other builders were editing in parallel, so the last two items below look transient.

| Command | Result now |
|---|---|
| `npx vitest run src/app.http.test.ts` (apps/api) | PASS, 16 of 16 |
| `npx vitest run src/authz-matrix.test.ts` (apps/api) | FAIL, 2 of N: `routes without a matrix entry: GET /v1/admin/ledger/integrity, GET /v1/admin/ledger/integrity/runs, POST /v1/analytics/events` and `GET /v1/admin/ledger/integrity: expected 'self' to be undefined`. Routes are new today (analytics-ingest, ledger integrity runs, migration 0089); `apps/api/test/authz-matrix.test.ts` was modified at 15:15 while I ran, and `vitest run test/authz-matrix.test.ts` finds no test files (not included by the vitest config; `src/authz-matrix.test.ts` is Oct 10). Transient, caused by today's work. |
| `npx vitest run src/contract` (apps/api) | FAIL, 1 of 14: `a planned operation must not have a Nest route ... Planned operations that are now served: POST /v1/analytics/events`. The analytics-ingest module just got routes; the OpenAPI spec (modified 15:14 today) still marks it `x-status: planned`. Transient/today. |

## Summary table

| # | Item | Still failing | Pre-existing before today | Evidence (short) | Blocks Phase A gate |
|---|---|---|---|---|---|
| 1 | api typecheck (5 errors), product-media pglite/in-memory/http (15 tests) | YES | YES | 0087 born Oct 13 00:15; pglite test Oct 12 23:20 stops at 0085; ports/machine changed Oct 13 00:16; none in today's file list | YES |
| 2 | catalog-wishlists.pglite `title_en_missing` | YES (6 of 11) | YES | `listing.ts` Oct 13 00:12 made EN title blocking; test Oct 11 12:35 posts AR only | YES |
| 3a | payouts R-5 sweeper pglite | YES (1 of 40) | YES (time bomb tripped Oct 14 12:00) | `T0 = Oct 14 12:00` vs DB `now()` trigger; files Oct 11 | YES |
| 3b | retention ctid idempotency pglite | YES (1 of 50) | YES (time bomb tripped Oct 16 01:00) | `NOW` pinned Oct 11, key expires Oct 16 01:00 vs SQL `now()` | YES |
| 4 | domain typecheck, `payouts.mutation.test.ts(300)` | YES | YES | file untracked, mtime Oct 12 19:55; `"PENDING"` vs `"REQUESTED"` | YES |
| 5 | check-inventory | YES (about 95 errors) | PARTLY: 19 product-media YES; about 76 NO | 0087 vs inventory Oct 12 23:40; 0088-0092 created 15:13-15:15 today | YES |
| 6 | rate limit dimension `store` | YES | YES | controller Oct 13 00:18; `decorators.ts` Oct 12 21:51; only use of `store` | YES |
| 7 | mobile reads `raw.versions` | YES (bug, silent) | YES | `background-removal/api.ts` Oct 13 00:17; contract is `{current_version, items}` with `thumbnail`, not `links` | NO (behaviour, not a red check) |
| 8 | ui-tokens `offer` leading 1.27 | YES | UNKNOWN (likely today) | `index.ts` 14:21 and `index.test.ts` 12:40 today; token used since Oct 15 20:49; uncommitted | YES |
| 9 | i18n `أوتلت` in `worlds.discover.storesBody` | YES | LIKELY YES / UNKNOWN | not in HEAD; consumer `WorldsScreen.tsx` Oct 15 16:41; `ar.ts` also edited today 14:43 | YES |
| 10 | depcruise 11 errors | YES | NO | every offending file born/modified today (spike, `css-entry`, egypt-areas test, analytics-ingest `events.ts`) | YES |
| 11 | e2e admin `E2E_PROD=1` `/_global-error` | YES (per log 15:03) | UNKNOWN | no `next.config`; single React and Next; likely env leak, shared `.next`, or new spike pages | NO unless prod-mode E2E is gated |
| a | `src/app.http.test.ts` | PASS | n/a | 16 of 16 | no |
| b | `src/authz-matrix.test.ts` | FAIL (3 routes) | NO (today, transient) | analytics events + ledger integrity routes | YES until matrix is updated |
| c | `src/contract` openapi drift | FAIL (1) | NO (today, transient) | `POST /v1/analytics/events` now served but still planned in spec | YES until spec updated |

## Failures that look caused by today's session

- Item 10: all 11 depcruise errors (admin-web spike with devDependency charts libs, `css-entry.ts` deep imports from seller-web and admin-web, mobile `egypt-areas.test.ts` deep imports, `analytics-ingest/domain/events.ts` importing `node:crypto`).
- Item 5, the NEW part: about 76 untagged columns from migrations 0088 (analytics rollups), 0089 (ledger integrity runs), 0090 (analytics facts privacy) and 0092 (web sessions), all created 15:13-15:15.
- Checks (b) and (c): authz matrix and OpenAPI drift, from the new analytics-ingest and ledger-integrity routes landing before the matrix and the spec were updated.
- Item 8 (probably) and item 9 (possibly): both involve files edited today (`ui-tokens/src/index.ts` 14:21, `i18n/src/ar.ts` 14:43); origin of the exact change cannot be proven.
- Item 11: possibly triggered by today's admin-web spike pages and concurrent use of `apps/admin-web/.next`.

Everything else (items 1, 2, 3, 4, 6, 7 and the 19 product-media inventory errors) belongs to the Oct 11-13 work and was already red or latent before today. Items 3a and 3b only started failing as the real date passed fixed test dates (Oct 14 12:00 and Oct 16 01:00).
