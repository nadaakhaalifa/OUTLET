# Consumer-driven contracts (Pact), spec A2.10

Folder: `tooling/pact/` (workspace-independent). Run: `node tooling/pact/run.mjs [consumer|provider|adapters|all]`. Offline, no install.

## What is checked
1. **Consumer contracts** (`src/consumer/mobile-contracts.ts`): 14 interactions, outlet-mobile to outlet-api, for auth, catalog, bag, checkout quote/checkout, orders, returns and privacy. Each states only what the mobile port in `derivedFrom` needs. Written to `pacts/outlet-mobile-outlet-api.json` (Pact v3.0.0). Each expected body is also validated against `docs/api/openapi.yaml`, so the consumer cannot assume fields the document forbids.
2. **Provider verification** (`src/provider/provider.test.ts`): boots the real `AppModule` through `apps/api/src/test/harness.ts` (in-memory adapters, same `configureApp`), replays every interaction, asserts status, headers, Pact matching rules, and the real response against the OpenAPI operation (declared status, media type, schema, documented headers). Cross-cutting: Problem+JSON and `X-Request-Id`, `Idempotent-Replayed` on replay, 422 on key reuse, 400 on malformed key, security headers.
3. **Adapter port suites** (`src/adapters/*.contract.ts`, exported via `src/index.ts`): `paymentProviderContract`, `courierContract`, `etaContract`. `fakes.contract.test.ts` runs them on `FakePaymentProvider`, `FakeBostaCourier` and `FakeEtaPort`. A real adapter must pass the same suite:
   ```ts
   paymentProviderContract("paymob (fixtures)", () => ({ port: new PaymobPort(cfg, new FixtureTransport()) }));
   ```
   Optional subject hooks (`markPaid`, `failNext`, `signedWebhook`, `goDown`, `rejectAll`) enable the failure and webhook cases; omit them and those cases are skipped.

## Pending interactions
`PENDING` in `provider.test.ts` lists consumer expectations the provider does not yet meet (Pact "pending pacts"). They must still fail; when one starts passing the suite fails so the entry is removed. Current entries: `GET /v1/me/orders` (documented, answers 404) and the privacy export 202 body (undocumented `locale`, `ready_target_at`).

## Swapping in @pact-foundation/pact
The DSL (`like`, `eachLike`, `regex`) mirrors `MatchersV3`. To use the official library: replace `buildPact` with `new PactV3({consumer, provider})` and `addInteraction({states, uponReceiving, withRequest, willRespondWith})` per spec, then `executeTest` against the real client; verify with `new Verifier({providerBaseUrl, pactUrls, stateHandlers})` pointing at a listening app (`await app.listen(0)` from the harness). The provider state names in the spec map one to one to `stateHandlers`. Add `@pact-foundation/pact` to `tooling/pact/package.json` (already listed as an optional devDependency).

## Known limits
The mobile app has no HTTP client yet, so consumer tests assert the expectations against OpenAPI rather than driving a real client; replace with client calls once `packages/api-client` exists. Provider states are limited to empty-bag shoppers (no catalog fixtures); rich states (populated bag, orders, returns) are covered by the per-module HTTP suites.
