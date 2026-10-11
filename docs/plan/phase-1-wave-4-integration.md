# Phase 1, wave 4 integration (money core)

Date: 2026-10-11. Integrator report for ledger posting, payments, checkout, refunds, store credit,
payouts, reconciliation, Seller Center web and Admin Console web. Synthetic data only. Paymob is not
contracted: only the in-repo fake and the recorded-fixture adapter exist. No live network calls.

## What was integrated

| Area | Change | Where |
|---|---|---|
| Domain exports | Namespaced exports `ledgerPosting`, `payments`, `checkout`, `refunds`, `storeCredit`, `payouts`, `reconciliation`. Every module bridge now imports from `@outlet/domain` (no `@outlet/domain/src/...` deep imports remain in wave 4 code) | `packages/domain/src/index.ts`, `apps/api/src/modules/*/domain/{bridge,seam}.ts` |
| Module registration | `LedgerModule`, `PaymentsModule`, `StoreCreditModule`, `RefundsModule`, `CheckoutModule`, `PayoutsModule`, `ReconciliationModule` and `MoneyBridgeModule` registered. In-memory default; Kysely stores when `adapters !== in-memory-dev` | `apps/api/src/app.module.ts`, `apps/api/src/persistence.ts` |
| Raw body | `NestFactory.create(..., { rawBody: true })` so PSP HMAC can be checked | `apps/api/src/main.ts` |
| Real cross-module ports | checkout to cart, inventory, promotions, tax-eta, orders, payments, ledger, store credit. Refunds and store credit to ledger. Refunds to store-credit restore. Payouts to ledger and admin approvals. Reconciliation integrity to ledger snapshots and wallet projection. Payments events to checkout | `apps/api/src/composition/*` |
| Contract | 23 new OpenAPI operations and 23 schemas; 29 authz-matrix rows; `docs/security/authz-matrix.md` updated | `docs/api/openapi.yaml`, `apps/api/test/authz-matrix.test.ts`, `docs/security/authz-matrix.md` |
| Privacy | Exporter manifest entries (or reasoned exemptions) for the wave 4 tables; RoPA regenerated | `apps/api/src/modules/privacy/application/exporter-manifest.ts`, `docs/privacy/*` |
| Frontends | `fast-check` and `@outlet/feature-flags` declared as devDependencies and linked; alias and tsconfig `paths` hacks removed; generated `next-env.d.ts` no longer references build output | `apps/seller-web`, `apps/admin-web`, `.gitignore` |
| Verify register | VR-INT-01..06 (integration assumptions) and VR-AC-01..05 (admin console) appended | `docs/compliance/verify-register.md` |

### How the modules are joined

Modules never import each other's internals. `apps/api/src/composition/` holds adapters that use only
public `index.ts` tokens and types. The adapters hold a `Late<T>` that `MoneyBridgeModule` fills at
`onApplicationBootstrap` with `ModuleRef.get(token, { strict: false })`; reading an unbound `Late`
throws.

| Port (owner) | Adapter | Notes |
|---|---|---|
| `CartPort` (checkout) | `CartAdapter` over `QuoteBagForCheckout`, catalog stores, membership, cart repository, inventory SKU directory | `isDrop` comes from the inventory SKU directory. Commission and tax category come from `CommerceTermsPort` (VR-INT-01) |
| `PromotionsPort` | `PromotionsAdapter` over `EvaluatePromotions` | identical shape |
| `TaxPort` | `TaxAdapter` over `QuoteOrderTax` | per-line VAT is exact; headline rate is the highest line rate |
| `InventoryPort` | `InventoryAdapter` over reserve, claim and release use cases | maps checkout method codes to inventory payment methods |
| `StoreCreditPort` | `StoreCreditAdapter` over `CreditHolds` and the lot store | spendable balance is remaining minus held |
| `PaymentProviderPort` and `PaymentRegistry` | `PaymentsModuleProvider`, `PaymentsRegistry` over `CreatePaymentIntent`, `VoidPayment`, `RefundPayment` | BNPL and COD have no PSP provider, so BNPL is rejected at intent creation (B3). `verifyWebhook` refuses everything: the payments module owns the PSP webhook |
| `LedgerPort` (checkout), `CreditLedgerPort`, `RefundLedgerPort`, `PayoutLedgerPort` | `LedgerGateway` over `PostingService` with a `LedgerUnitOfWork` | one idempotent write path; `PostingConflictError` becomes `LedgerKeyConflictError` for checkout |
| `OrdersIntakePort` | `OrdersAdapter` over `PlaceOrders` | |
| `PayoutApprovalsPort` | `AdminPayoutApprovals` over the admin store | scan limited to 200 (VR-INT-06) |
| `IntegrityPort` (reconciliation) and `ProjectionSource` (ledger) | `LedgerIntegrityPort`, `StoreCreditProjection` | |
| payments events to checkout | `PaymentEventsToCheckout` calls the new `HandlePaymentWebhook.applyVerified` | payments has already verified and deduplicated; checkout records the message id and applies by compare-and-swap |

Two behaviour changes inside wave 4 code were needed:

1. `StoreCreditPort.capture` and `release` now receive `userId` (and `orderEntryKey` for capture),
   because the store-credit module addresses holds by `(userId, ref)`. The saga passes
   `keyOf(orderGroupId, "recognised")`, the key under which it posts the order entry.
2. `HandlePaymentWebhook` gained `applyVerified(...)`, used by `execute` after HMAC verification and
   by the payments bridge. No change to the verified path's behaviour.

Outside production only, development fixtures fill the ports no module can satisfy (risk, age
policy, kill switch, addresses, app attest, COD confirmation, metrics for checkout; bank, name
match, payout rail, payout risk and flags for payouts; clearing, ETA, alerts and flags for
reconciliation). Production passes none of them, so a missing real port is a boot failure inside the
module. `AppModule.register` for production already stops earlier at the platform's
`NoProductionAdaptersError`, as before.

## Verification (real results)

Machine load was high (load average 22 to 44, other waves running). Where a command timed out under
that load it is called out.

| Command | Result |
|---|---|
| `cd apps/api && vitest run src/composition` | 2 files, 7 tests passed: real in-memory modules end to end (cart line, quote, place, payments intent, `payment.succeeded` bridged, order placed once, seller payable positive, trial balance and hash chain intact, replay is a no-op, malformed payload throws, unknown group stored) and migrations 0031 to 0035 contiguous, lint-clean and applied |
| `cd apps/api && vitest run src/authz-matrix.test.ts` | 402 passed (every route has a row, mode matches, OpenAPI and authz-matrix.md list every route) |
| `node tooling/api/validate-openapi.mjs` | `openapi: OK  operations: 245  writes: 125 (webhooks: 3)  public: 5  schemas: 216` |
| `node tooling/privacy/generate-ropa.mjs` then `node --test tooling/privacy/test/inventory.test.mjs` | 31 tests, 31 pass, 0 fail |
| `node tooling/privacy/check-inventory.mjs` | `PASS: 176 tables, 1639 fields, 0 errors, 3 warnings` |
| `pnpm -r typecheck` | all 17 projects Done, no errors |
| `pnpm i18n-check` | `packages/i18n: 862 keys, parity OK` (identical-text warnings only) |
| `cd packages/domain && vitest run` (via `pnpm -r test`) | 69 files, 1356 tests passed |
| `cd apps/seller-web && vitest run` / `apps/admin-web` | 75 passed / 57 passed; `tsc --noEmit` clean in both |
| `cd apps/api && vitest run src/modules/{payments,refunds,ledger}` | 17 files, 215 tests passed |
| apps/api full suite | see the "Full API suite" section below |
| dependency-cruiser on Node 24 (`packages apps`) | `13 dependency violations (6 errors, 7 warnings)`; none in wave 4 code (see Leftovers) |
| `pnpm lint` | 51 errors, none in wave 4 paths: all in other waves' stylist, recommendations, llm-gateway, `tooling/load`, `tooling/pact`, `tooling/copy-lint`, `tooling/dora` |
| Stryker `stryker.ledger-posting.mjs` (Node 24.21) | not measured: dry run green (56 tests), then `spawn pgrep EAGAIN` in the sandbox |

## Full API suite

`cd apps/api && vitest run --testTimeout=120000 --hookTimeout=120000 --maxWorkers=3` on a loaded
machine, after the wave 4 work: `Test Files  5 failed | 192 passed (197)`, `Tests  4 failed | 3209 passed
| 1 skipped (3214)`. Every failure is a wave 5 test, none is a wave 4 test:

| Failing test | Why it is not wave 4 |
|---|---|
| `privacy/exporter-coverage.test.ts` | now lists wave 5 tables only: `coin_debts`, `coin_events`, `entitlements`, `game_entitlements`, `game_plays`, `history_clear_requests`, `personalization_settings`, `plus_savings_ledger`, `plus_signups`, `recently_viewed`, `reward_config_versions`, `spend_events`, `tier_status`, `trial_claims`. The wave 4 tables (`checkout_*`, `payment_intents`, `refunds`, `credit_*`, `payouts`, `payout_status_history`) were added by this integration and pass (the same test passed 84 of 84 in `src/modules/privacy` before wave 5 tables landed) |
| `recommendations/history-flows.http.test.ts`, `recommendations/adapters/kysely-store.pglite.test.ts`, `recommendations/dbg.test.ts` (suite fails to load) | recommendations and history module, wave 5 |
| `budget/adapters/kysely-store.pglite.test.ts` (60 s READ ONLY transaction test) | budget module, wave 5 |

Earlier in the session, with only wave 4 present, the same suite was `164 passed, 1 failed (exporter
coverage for the wave 4 tables, since fixed)` and `Tests 2871 passed`.

## Leftovers (honest list)

Blocking or gating:

1. **Mutation score for ledger posting is unmeasured.** ADR-0019 requires >= 80% on ledger-adjacent
   money code. Run `pnpm mutation:ledger-posting` in `packages/domain` on a normal Node 24 runner and
   record the table in `docs/engineering/mutation-testing.md`. Payouts, reconciliation, refunds,
   store-credit and checkout domain code have no Stryker config.
2. **Fable-tier money review is still outstanding** (ADR-0021, global delegation rule) for checkout
   compensation order and parked-receipt entries (VR-CHK-6, VR-CHK-7), refund routing, payout send
   ordering and dual-approval binding. Not done by this integrator.
3. **`packages/db` suite fails on a migration gap that is not wave 4**: `expected migration 0036
   but found 0036_subscriptions.sql`. Wave 5 files (0040, 0042 to 0045) skip 0036 to 0039. Wave 4
   migrations 0031 to 0035 are contiguous and apply (tested in `src/composition/migrations.test.ts`).
   The wave 5 owner must fill or renumber.
4. **depcruise errors are wave 5 deep imports** (`subscriptions`, `stylist`, `rewards`,
   `recommendations`, `history`, `budget` bridges importing `packages/domain/src/...`). The same
   alias-import fix used here applies; not touched because those paths belong to other agents.

Money flow not yet real (all tracked in the verify register):

5. **No outbox relay and consumer registry exists.** Nothing calls `PaymentEventsToCheckout.handle`,
   `IntakeRefundIntent`, `ProcessPaymentWebhook.handle`, `RecoverSagas`, `SweepRefunds`,
   `CreditHolds.sweepExpired`, `SweepExpiredCredit`, `ReconcileWallets`, `ExpirePaymentIntents`,
   `PayoutCommands.schedule/advanceSent`, `ScheduleReconciliation.tick` or `INTEGRITY_JOB` on a
   schedule outside tests. The adapters and use cases are ready; the scheduler and relay owner must
   register them with retry and DLQ (VR-INT-02).
6. **Refund facts and PSP executor are development fakes** (VR-INT-03). `return.refund_intent`
   cannot become a refund end to end until orders and payments expose tenders, VAT and voucher
   funding.
7. **Commission rate and tax category have no production source** (VR-INT-01); checkout in
   production will not boot the cart adapter without a `CommerceTermsPort`.
8. **Reconciliation clearing lines and ETA submissions have no read port** (VR-INT-05); only the
   integrity suite runs on real data.
9. **Paymob adapter is fixture only** (VR-PAY-*). No HTTP transport exists in the repo.
10. **Checkout's own webhook route is inert in the composed app** (answers 404) because the payments
    module owns `/v1/webhooks/{provider}`; kept so a direct provider adapter can be registered.

Quality gaps:

11. The wallet response in OpenAPI (`WalletBalances`, `WalletTransactionPage`) predates the
    implemented wire; only the new operations were written from the controllers' real wire. Align
    the older two schemas in the next contract pass.
12. `apps/api/src/composition` reads payout approvals with a bounded scan (VR-INT-06).
13. Browser, screen reader, real passkey and live API are untested for both web apps (builders'
    gaps stand). Arabic copy needs native review.
14. `pnpm install` was not run. The lockfile importer entries for `apps/seller-web` (fast-check) and
    `apps/admin-web` (`@outlet/feature-flags`) were edited by hand and the two `node_modules`
    symlinks created by hand; run `pnpm install --frozen-lockfile` once to confirm the lockfile.
15. Admin Console needs `GET /v1/admin/me` and web passkey support (VR-AC-01, VR-AC-02). Seller Center
    needs seller me/role, TOTP, upload and shipment id endpoints (VR-SC-01..05).
16. Exporter manifest declares ownership for the wave 4 tables; the exporters themselves are still
    to be implemented by the owning modules.

## After review

- Card-checkout quote 500: cause was no registered commerce terms for the test store (commission now fails closed, `UnknownStoreTermsError`). Fixed in the test seed via `COMMERCE_TERMS_REGISTRY`; behaviour unchanged. New test proves an unknown store fails the quote closed and creates no payment intent.
- I-2: `createPaymentEventsRelay` (outbox relay + inbox consumer `checkout.payment-events`) drives `PaymentEventsToCheckout`. Test: signed PSP webhook over HTTP, payments consumer drain, outbox rows through the relay, saga PLACED, duplicate delivery changes nothing. Test harness now enables `rawBody`.
- I-3: `LedgerClearingAdapter` reads the real ledger snapshots; test asserts the PSP clearing line for an order group.
- Depcruise (Node 24): 0 errors. Waiting room gets an `AdmissionCodec` port (domain/ports.ts), adapter `jwtAdmissionCodec` wired by the module; gift-cards and ads bridges use `@outlet/domain`; refunds fixtures copied locally for the composition test.
