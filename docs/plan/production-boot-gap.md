# Production boot gap

Status: the API and the worker now boot with `NODE_ENV=production DEV_FIXTURES=false` over real Postgres 16 (ADR-0029). The 2026-10-11 first run (44 modules throwing `NoProductionAdaptersError`) is closed for 36 of 43 module directories. This file records the real output and what remains.

## How it was run

    cd apps/api && node build/build.mjs          # built 1055 files to dist
    # throw-away Postgres 16 cluster on a random port, all 46 migrations applied with psql,
    # LOGIN role outlet_app IN ROLE app_user (RLS applies, not a superuser)
    NODE_ENV=production DEV_FIXTURES=false DATABASE_URL=postgres://outlet_app@127.0.0.1:<port>/outlet \
      OTP_PEPPER=... IP_HASH_KEY=... AGE_BLOCK_KEY=... SIZE_DEMAND_PSEUDONYM_KEY=... PORT=<free> \
      node dist/apps/api/src/main.js
    # worker: node dist/apps/api/src/main.worker.js

Processes were stopped by exact PID and the cluster was deleted. Script: kept in the session scratchpad, not committed.

## Real output

`GET /v1/health` -> `200 {"status":"ok"}`.

`GET /v1/ready` -> `200`:

    {"status":"ready","checks":{"database":"ok"},
     "providers":{"psp.paymob":"unconfigured","psp.recurring":"unconfigured","psp.b2b-intents":"unconfigured","payout.rail":"unconfigured","bank.name-match":"unconfigured","settlement.files":"unconfigured","bnpl.quotes":"unconfigured","courier.bosta":"unconfigured","courier.aramex":"unconfigured","eta.portal":"unconfigured","messaging.sms-whatsapp":"unconfigured","push.apns-fcm":"unconfigured","llm.gateway-provider":"unconfigured","kms.envelope":"unconfigured","secrets.manager":"unconfigured","object.store":"unconfigured","attestation.app-attest":"unconfigured","flags.provider":"unconfigured","queue.redis":"unconfigured","search.typesense":"unconfigured","crawler.egress":"unconfigured","moderation.classifier":"unconfigured","analytics.warehouse":"unconfigured","internal.wiring":"unconfigured"},
     "modules":{"composed":36,"blocked":["auth","privacy","catalog","price-integrity","wishlists","sizing","notifications"]},
     "dependencies":{"outbox":{"state":"ok","pending":0,"oldest_age_seconds":0,"dead_lettered":0}}}

Startup log (names only):

    {"level":"warn","event":"providers.unconfigured","providers":[...24 names as above...]}
    {"level":"warn","event":"modules.not_composed","modules":["auth","privacy","catalog","price-integrity","wishlists","sizing","notifications"]}

`POST /v1/webhooks/paymob` -> `403 ip_not_allowed` (deny-all allow list until a PSP is configured).

Platform adapters against the real cluster: idempotency claim `acquired`, duplicate `in_flight`, complete `true`, replay `completed`; two authorization audit records appended and `audit_log_verify()` returned 0 problems.

Worker: `outbox.relay` ran, an inserted `catalog.product_created` event was published (`published=1`), `outbox_events.published_at` set, readiness afterwards `pending 0`. Jobs owned by privacy and notifications were skipped with `worker.job_skipped`. `waiting-room.admit` failed with `ProviderNotConfiguredError` before the production default blocked the `drops` capability (fixed).

## Module status (43 directories under src/modules, including retention, added concurrently)

Composed (36): admin, ads, budget, cart, checkout, courier-aramex, drops, fulfillment, gift-cards, history, hub-consolidation, inventory, ledger, llm-gateway, orders, payments, payouts, price-crawler, promotions, recommendations, reconciliation, referrals, refunds, resale-lane, retention, returns, reviews, rewards, search, seller-analytics, store-credit, stores, stylist, subscriptions, tax-eta, waiting-room.

Originally blocked (7; catalog and wishlists are now composed, see rows), cannot be composed without changing the module (owners must add a seam or Kysely adapters):

| Module | Exact reason |
|---|---|
| auth | COMPOSED (was blocked). Kysely stores on migrations 0006 + 0047 (users, identities, devices, session families, refresh tokens, `auth_sessions`, OTP challenges and send log, age gate blocks and passes, nonces, passkey challenges and credentials) with RLS; EdDSA JWT access tokens (`JoseTokenService`, ADR-0030); real Apple/Google JWKS fetcher; real WebAuthn verification. The deny-all authenticator is removed. Providers default to Unconfigured and fail closed: `kms.envelope` (phone, DOB, e-mail encryption + blind indexes, 503), `secrets.manager` (signing keys: 401 on bearer routes, 503 on issue), `attestation.app-attest` (503 on every attested route), `messaging.sms-whatsapp` (503 `provider_not_configured`). Until an operator supplies those four, no shopper can sign in; `ProductionOptions.auth` takes the real adapters (tests inject doubles). Gaps: no env surface for key material, auth events outboxed in their own transaction, no real attestation / KMS / SMS adapters. Proof: `apps/api/src/production/auth.production.test.ts` |
| privacy | COMPOSED. Kysely consent/request/breach stores, `KyselyDeletionBlockers` (orders, returns, disputes, store credit), per-group `KyselyGroupExporter` (decrypts P2/P3 only via the `kms.envelope` cipher port), `KyselyErasureExecutor` (inventory snapshot driven, idempotent). External and Unconfigured: `kms.envelope`, `object.store` (exports stay `requested`). Gaps: manifest tables with no table in the schema or no user key are listed in the archive manifest `gaps`; append-only tables are not rewritten; `identities` ciphertext and `savings_goals` are omitted (no AAD contract). |
| catalog | COMPOSED (was blocked). Real Kysely products/taxonomy/imports; events appended to the outbox in the write transaction (`TransactionalOutboxEvents` refuses any other route); stock read from inventory's STANDARD pool and opening stock seeded through `applySync` (idempotent per SKU); prices through a late-bound `PriceBlockReader` bound to the price-integrity `PRICE_BLOCK_READER` (absent evidence = plain price, sanitiser drops any reference without a verified badge); stores via the stores module (`KyselyStoreRepository` legal-identity projection, visibility, favourites); size-chart status via the sizing chart repository (paged scan, no by-id read exists); media = HMAC-signed URLs capped at 900 s, none when no media base URL/key is configured. Unconfigured: `object.store` (image references and CSV imports answer 503 `provider_not_configured`; an active listing needs an image, so nothing can be published until an object store is configured). `forRoot` reads persistence first and throws `MissingCatalogPortsError` only for missing ports. Gaps: no media base URL/key in `AppConfig` yet (`CatalogWiringOptions.media`), inventory has no location-provisioning API (`KyselyStoreLocations` reuses or inserts one SELLER_WAREHOUSE row), product insert and opening-stock seed are two transactions |
| price-integrity | COMPOSED. Kysely event/claim/enforcement stores, `KyselySkuDirectory` (read-only over products and skus), shadow-only external evidence (none, claims rest on the internal ledger); crawler evidence stays with `price-crawler`. |
| wishlists | COMPOSED (was blocked). Kysely repository; `wishlist.shared`, `wishlist.share_revoked` and `wishlist.alert_due` are written to the outbox inside `save`/`claimAlert` (the dedupe claim and the event commit together, so price-drop and back-in-size alerts stay event driven and exactly-once per key); product facts via the catalog public surface (`ProductFactsReader`); owner nickname: auth stores none, so `NoOwnerNicknames` returns null (gap) |
| sizing | COMPOSED (was blocked). KMS envelope cipher (`EnvelopeFieldCipher`, per-record DEK, key id + version stored, AAD table:row:column) over `KmsPort`, Unconfigured (`kms.envelope`) so measurements cannot be saved or read: 503 `provider_not_configured`. Consent via privacy history. Fit catalog, order lines, events are `internal.wiring` (503). Gap: real KMS adapter |
| notifications | COMPOSED (was blocked). Kysely stores, privacy consent history, Unconfigured push/WhatsApp/SMS/email providers that throw at call time (recorded as FAILED attempts, retried, never SENT), Kysely `inbox_processed`. Gaps: contacts are `internal.wiring` (auth has no contact index, so nothing sends), no production template seed (seed ids are not UUIDs), events go to a log not the outbox |

Consequences while auth was blocked: no login, so no shopper route was usable; the catalog, wishlist, sizing and notification endpoints do not exist in production; cross-module reads that depended on them are bound to `internal.wiring` (503).

## Ports bound to `internal.wiring` (Unconfigured, 503)

These are not external providers; they are cross-module adapters that do not exist yet. Cart catalog, membership and platform config; orders store lookup; returns lines, membership, history, exchange stock, events; search fallback, facts, scope, directory; tax events; seller-analytics product store; reviews purchases, sellers, products, profiles; checkout risk, age policy, addresses; payouts source, statement source, bank, risk; reconciliation eta, alerts; refunds facts; subscriptions ages, refunds, ledger, approvals; gift-cards store credit, audit, age; budget consent, spend, bag, wishlists; stylist candidates, live, bag, personalization, budget; recommendations catalog, ranker, personalization, sizes; history consent, products; rewards ledger, credit, plus, vouchers, approvals; drops inventory, verifier; waiting-room gate, entitlements; price-crawler embeddings, attributes, fingerprints; hub facts, outbound, ledger; resale returns, consent, terms, catalog, ledger; ads enforcement, eligibility, ledger, attribution; llm cache.

## Residual honesty items

- Rate limiter is per process (Redis unconfigured): limits are per replica.
- Optional ports left at module defaults (not listed as required by the module): search event publisher, fulfillment metrics, privacy/notification internals (blocked modules anyway). `ProcessMetrics` counts in memory for checkout.
- Outbox events with no in-process consumer are acknowledged and counted (see ADR-0029); only `payment.*` has a consumer.
- Cross-package import: `production/flags.ts` imports `packages/feature-flags/src` by relative path because `@outlet/feature-flags` is not a dependency of apps/api (adding it needs a pnpm install). Replace with the workspace dependency at the next install.
- dependency-cruiser could not be run (it rejects Node 25); not verified.
- Two edits outside the owned paths: `platform/platform.module.ts` (production seam) and `platform/health.controller.ts` (readiness report).


## Update 2026-10-11: auth composed (ADR-0030)

`auth` is now a composed module (`MODULE_BINDINGS.auth`), the deny-all authenticator is gone, and `GET /v1/me` exists. Over PGlite with all 47 migrations and test doubles only for the four external providers, the production graph signs a user in by OTP, Apple and passkey, authenticates `GET /v1/me` and `GET /v1/me/sessions` with the issued EdDSA token, rotates refresh tokens, revokes the family on reuse and rejects forged / wrong-audience / expired / alg-none tokens (14 tests in `auth.production.test.ts`). With no providers configured the same graph answers 401 on bearer routes and 503 `provider_not_configured` on age gate, OTP, social and passkey sign-in. Not run: a full `node dist/.../main.js` boot against the throw-away Postgres cluster (the store contract itself passed against a real Postgres 18 under a LOGIN role in `app_user`, 57 tests, 14 of them on real Postgres).
