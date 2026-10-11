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

Blocked (7), cannot be composed without changing the module (owners must add a seam or Kysely adapters):

| Module | Exact reason |
|---|---|
| auth | no Kysely adapters for users, sessions, OTP challenges, passkeys, age-gate rows; tokens come from `DevTokenService`; dev attestation. Authenticated routes answer 401 via a deny-all `AUTHENTICATOR` |
| privacy | repositories are options, but blockers (`FakeBlockers`), exporters (`FakeExporter`), object store and outbox are built in `forRoot`; `forRoot` throws first |
| catalog | Kysely product repositories exist, but stock, prices, stores, size charts, media, uploads and events are dev fixtures |
| price-integrity | `persistence` option exists but `forRoot` throws before reading it |
| wishlists | `repository` option exists but catalog read, owner profiles and event log are in-memory |
| sizing | repositories option exists but `forRoot` builds `DevAesGcmFieldCipher` (P3 measurements) and in-memory consent, catalog, order lines, events |
| notifications | repositories option exists but every channel is a `FakeProvider` built in `forRoot` |

Consequences of those seven: no login, so no shopper route is usable; the catalog, wishlist, sizing and notification endpoints do not exist in production; cross-module reads that depended on them are bound to `internal.wiring` (503).

## Ports bound to `internal.wiring` (Unconfigured, 503)

These are not external providers; they are cross-module adapters that do not exist yet. Cart catalog, membership and platform config; orders store lookup; returns lines, membership, history, exchange stock, events; search fallback, facts, scope, directory; tax events; seller-analytics product store; reviews purchases, sellers, products, profiles; checkout risk, age policy, addresses; payouts source, statement source, bank, risk; reconciliation eta, alerts; refunds facts; subscriptions ages, refunds, ledger, approvals; gift-cards store credit, audit, age; budget consent, spend, bag, wishlists; stylist candidates, live, bag, personalization, budget; recommendations catalog, ranker, personalization, sizes; history consent, products; rewards ledger, credit, plus, vouchers, approvals; drops inventory, verifier; waiting-room gate, entitlements; price-crawler embeddings, attributes, fingerprints; hub facts, outbound, ledger; resale returns, consent, terms, catalog, ledger; ads enforcement, eligibility, ledger, attribution; llm cache.

## Residual honesty items

- Rate limiter is per process (Redis unconfigured): limits are per replica.
- Optional ports left at module defaults (not listed as required by the module): search event publisher, fulfillment metrics, privacy/notification internals (blocked modules anyway). `ProcessMetrics` counts in memory for checkout.
- Outbox events with no in-process consumer are acknowledged and counted (see ADR-0029); only `payment.*` has a consumer.
- Cross-package import: `production/flags.ts` imports `packages/feature-flags/src` by relative path because `@outlet/feature-flags` is not a dependency of apps/api (adding it needs a pnpm install). Replace with the workspace dependency at the next install.
- dependency-cruiser could not be run (it rejects Node 25); not verified.
- Two edits outside the owned paths: `platform/platform.module.ts` (production seam) and `platform/health.controller.ts` (readiness report).
