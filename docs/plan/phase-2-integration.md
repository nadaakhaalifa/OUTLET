# Phase 2 integration status

Date: 2026-10-11. Scope: composition of the Phase 2 modules into `AppModule`, the authorization matrix, the OpenAPI contract and the kill-switch registry. Engineering on synthetic data only; legal, residency and funds-flow ADRs (0002, 0003, 0019) still gate real data.

## What is wired

| Module | In `AppModule` | Postgres store (`persistence.ts`, `phase2.*`) | Dev fakes (dev boot only) |
|---|---|---|---|
| subscriptions (Plus) | yes | `KyselySubscriptionStore` | all ports; recurring-webhook verifier rejects everything |
| gift-cards | yes | `KyselyGiftCardStore` | all ports |
| budget | yes | `KyselyBudgetStore` | all ports |
| stylist | yes | `KyselyStylistStore` | all ports, fake LLM |
| llm-gateway (global) | yes | `KyselyAuditStore`, `KyselyTokenUsage` | fake provider, in-memory cache |
| recommendations | yes | `KyselyRecoStore`, `PgVectorIndex` | all ports |
| history | yes | `KyselyHistoryStore` | all ports |
| rewards | yes | `KyselyRewardsStore` | all ports, games OFF |
| drops | yes | `KyselyDropStore` | all ports, no-op admission verifier |
| waiting-room | yes | `KyselyAdmissionStore` | in-memory queue, all ports |
| price-crawler | yes | `KyselyCrawlStore` | all ports, crawling OFF (`StaticCrawlFlags(false)`) |
| hub-consolidation | yes | `KyselyHubStore` | all ports |
| resale-lane | yes | `KyselyResaleStore` | all ports |
| courier-aramex | yes | none (HTTP adapter) | fake transport and credentials |
| ads | yes | `KyselyAdsStore` | all ports |

Mode rules (same as the Phase 1 and money modules):

- `NODE_ENV=test` with fixtures: each module uses its own in-memory defaults.
- `NODE_ENV=development` with fixtures: `AppModule` passes explicit DEVELOPMENT FIXTURES (the modules refuse implicit fixtures outside test).
- `adapters !== in-memory-dev`: only the Postgres stores are passed. Every cross-module port must be a real adapter or boot fails with the module's `Missing*PortsError`. The platform's `NoProductionAdaptersError` still fires first today, so nothing here weakens that gate.
- `AppModuleOptions.phase2.<module>` overrides any of the above (tests, staging).

## Not bridged to real adapters yet (honest gaps)

Each of these runs on a dev fake in dev and refuses to boot in production until a real adapter exists:

- Subscriptions: PSP recurring charges, card vault fingerprint, refund router, ledger posting, ETA receipts, age policy, dual-approval, webhook MAC verifier.
- Gift cards: KMS HMAC key and envelope cipher, store-credit posting (ADR-0021), PSP intents, delivery provider.
- Budget: consent reader (`budget_insights`), orders spend source, cart bag total, wishlist plan source.
- Stylist and recommendations: catalog/size/stock candidate source, live price re-validation, embeddings, ranker model.
- Rewards: ledger, store-credit and voucher bridges, attestation, dual approval, Plus entitlement.
- Drops and waiting room: inventory pool, social signals, Redis queue, signing-secret manager, bot score, attestation. The waiting-room `DropGatePort` should be bound to the drops module `DropGate`, and drops' `AdmissionVerifierPort` to the waiting-room `AdmissionVerifier` (same process, token provider swap only).
- Price crawler: allow-listed egress proxy, DNS resolver, seller site adapters, domain verifier, KMS token vault, ANN index, llm-gateway attribute check.
- Hub and resale: parcel facts, courier router over the fulfillment `CourierPort`s (Aramex outbound exists in `courier-aramex`), returns facts, commission terms, ledger.
- Ads: price-integrity enforcement, catalog eligibility, B2B charge intents, ledger, bot score, orders attribution, KMS secret.

## Authorization matrix and OpenAPI

- 92 Phase 2 routes are registered. Each has a row in `apps/api/test/authz-matrix.test.ts` (delegated to the owning module suite, which carries the non-owned 404, missing-role 403 and wrong-audience 401 cases) and in `docs/security/authz-matrix.md`.
- The central suite enforces for each: declared authz mode equals the row, 401 without credentials (public routes: a 4xx), an OpenAPI operation and a doc row.
- 92 OpenAPI operations were added (`x-phase: 2`, snake_case wire, Problem+JSON, `Idempotency-Key` on every write, rate-limit metadata from the controllers). Validator: `node tooling/api/validate-openapi.mjs` passes (337 operations).
- `POST /v1/webhooks/{provider}/recurring` is declared as a webhook (HMAC security, dedup key) because the controller authenticates by provider MAC, not by a token.

## Kill switches (ADR-0028, "allowed when true")

`packages/feature-flags` keeps the 14 A2.12 switches in `KILL_SWITCHES` and adds `PHASE2_KILL_SWITCHES` (23) plus `release.budget_suite`. Polarity is documented in the registry header: `true` = allowed, `false` (default, fail closed) = blocked. `FlagClient.describeState(key)` returns `allowed | blocked` for the admin console and runbooks.

Added: `kill.plus.sales`, `kill.plus.recurring.{card,mobile_wallet,apple_pay}`, `kill.gift_card_redemption`, `kill.rewards_coins`, `kill.budget_caps`, `kill.stylist_ml`, `kill.llm_search_parse`, `kill.sponsored_products`, `kill.hub_consolidation`, `kill.resale_lane`, `kill.waiting_room`, `kill.mystery_box`, `kill.drop_type.{public,members_only,flash_hour,mystery_box,price_ladder,last_chance}`, `kill.search_engine`, `kill.courier.{bosta,aramex,mylerz}`.

Follow-ups outside this change: bind each module's flag port to `FlagClient` in the composition root (today they use their fakes), render the new switches in the admin console (it lists switches outside its expected 14 automatically), and decide the ADR-0028 rename.

## Verification

`apps/api`: `npx vitest run`, `tsc --noEmit`, `eslint` on touched files; `packages/feature-flags`: `npx vitest run`; `node tooling/api/validate-openapi.mjs`.
