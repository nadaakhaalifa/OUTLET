# Generated API client (master prompt T1)

`docs/api/openapi.yaml` is the contract. `packages/api-client` is generated from it and used by the mobile app (and, later, the two web apps).

## Layout
| Path | What |
|---|---|
| `tooling/api/generate-client.mjs` | Deterministic generator, no network. `node tooling/api/generate-client.mjs` writes, `--check` exits 1 when the committed files are stale. Exports `generate(yamlText)` for tests. |
| `packages/api-client/src/generated/schemas.ts` | One Zod schema + inferred type per `components.schemas` entry. Snake_case wire shape. `additionalProperties: false` becomes `z.strictObject`, so an unknown field is drift. Money stays `{amount, currency}` strings on the wire. |
| `packages/api-client/src/generated/operations.ts` | One entry per `operationId` (method, path, params, input and output Zod, security, idempotency) and the `OutletClient` interface. |
| `packages/api-client/src/client.ts` | `createClient({ baseUrl, getToken, refreshToken, fetch, getHeaders, ... })`. Hand written, generic over the generated table. |
| `packages/api-client/src/runtime/*` | `ApiError` (Problem+JSON), `NetworkError`, `TimeoutError`, `AbortedError`, `ContractDriftError`, UUIDv7, cursor pagination (`paginate`, `collectPages`). |

## Behaviour
- **Request input is Zod-parsed before sending**; invalid input throws `ContractDriftError(phase: "request")` and nothing is sent.
- **Every success body is Zod-parsed.** A mismatch throws `ContractDriftError { operationId, phase: "response", issues[], status }`. It never passes silently. A 4xx body that is JSON but not Problem+JSON is `phase: "problem"` drift; a non-JSON gateway error becomes an `ApiError` with `problemValid: false`.
- **Idempotency-Key**: operations that declare the header and are not GET/HEAD get a UUIDv7 once per logical call; the same key is reused on every retry. `options.idempotencyKey` overrides (persisted checkout attempts).
- **Retries** (exponential backoff with jitter, default 2): only for GET/HEAD or keyed requests, on network error, timeout, 502/503/504, and 429 with a short `Retry-After`. A user abort is never retried.
- **401**: one refresh through the injected `refreshToken`, shared by concurrent requests, then the request is replayed once. If refresh yields `null` the 401 is surfaced.
- **ETag**: every response carries `etag`; pass `headers: { "If-None-Match": etag }` to get `{ notModified: true }` on 304. PATCH operations require `If-Match`.
- **Timeout and cancel**: per-client `timeoutMs` (default 10 s), per-call `timeoutMs` and `signal`.
- **No logging**. `onEvent` receives the operationId, method, path template, attempt, status and duration only. Headers, URLs and tokens never reach it.
- `dataOf(res)` unwraps a response that cannot be 304.

## Regenerating
After editing `docs/api/openapi.yaml`: `node tooling/api/generate-client.mjs`, then commit the two generated files. `packages/api-client/src/generator.test.ts` regenerates in memory and fails when the committed files differ (the drift guard). Because other work edits the OpenAPI, this guard can fail on a fresh checkout: regenerate.

## Tests
- `generator.test.ts`: determinism, drift guard, one entry per operationId.
- `client.test.ts`: runtime behaviour with a scripted fetch (drift errors, Problem+JSON, idempotency reuse, retry rules, refresh, 304, pagination, abort, timeout).
- `contract.test.ts`: boots the real Nest `AppModule` in-process (`apps/api/src/test/harness.ts`), listens on an ephemeral loopback port and calls the real API through the generated client (OTP, bag, consents, orders, stores, search, Plus paywall, wishlists with idempotent replay, errors as Problem+JSON, and a list of KNOWN server-vs-spec drifts that must throw `ContractDriftError`).
- Mobile: `apps/mobile/src/services/adapters.test.ts` (adapters with a fake fetch).

Run: `cd packages/api-client && node ../../apps/api/node_modules/vitest/vitest.mjs run` (the package has its own `vitest.config.mjs` that borrows the SWC decorator transform from `apps/api`, like `tooling/pact`).

## Mobile wiring
- `apps/mobile/src/services/api-client.ts` is the only import of the package (relative path, like `workspace.ts`). After `pnpm install` links `@outlet/api-client`, change that one line.
- `services/runtime.ts`: `apiBaseUrlFromEnv()` reads the literal `process.env.EXPO_PUBLIC_API_BASE_URL` (Expo inlines it). `configureApiRuntime()` is called by `createServices()` with the token storage, install id, locale and platform. One shared client reads the bearer from secure storage and refreshes through `POST /v1/auth/refresh` (a second, refresh-free client, so a refresh cannot recurse).
- `state/ports.ts`: `getFeaturePorts()` builds `createApiPorts()` when a base URL is set and the in-memory fakes otherwise. A base URL without a registered runtime throws; it never falls back to fakes. `setFeaturePorts()` still overrides.
- `api/index.ts`: `createApi` / `createAgeGate` use `HttpOutletApi` / `HttpAgeGate` when a runtime exists, so release builds with a base URL no longer throw. Without a base URL a release build still refuses the dev fixtures.
- `features/<x>/api.ts`: one adapter per port. Wire money (`{amount}`, `amount_minor`, `*_piastres` strings) is parsed to `bigint`; no floats. Errors become `PortError("offline" | "failed")`, with the original error (including `ContractDriftError`) as `cause`.
- Device-bound ports (`paymentLauncher`, `mapPin`, `photos`) are not API calls and remain the in-app fakes until the native modules land.
- The API-backed stylist is its own `OutletBagPort`: the server already writes accepted items into the bag, so `BagBackedStylist` is not used (it would add every item twice).

## What the adapters refuse (PortError, no invented data)
`returns.load`, `plus.subscribe`, `giftCards.purchase/createPot/contribute`, `rewards.convert`, `stylist.swap`, `wishlists.startCoolOff`. Each needs an input or an operation the OpenAPI does not have; see `docs/plan/api-client-gap.md`.
