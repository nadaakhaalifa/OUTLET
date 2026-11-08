# ADR-0012 (proposed): HTTP layer skeleton for apps/api

- Status: **Proposed**. Lives here until the owner of `docs/adr/` moves it to `docs/adr/0012-http-layer.md`.
- Two-key area (auth, policy, RLS context): chief-reviewer checkpoint required before merge (`needs-human`).
- Sources: BUILD-PROMPT §2 (route rules, negative authz, query counts), §3 (stateless NestJS, timeouts and breakers, pools with `application_name`), §4 (deny by default, ES256 10-min JWT, GCRA/token bucket, CGNAT-aware keys, budgets, Problem+JSON); master prompt §T3; `docs/api/openapi.yaml` + `docs/api/README.md` (API-01..13); ADR-0011.

## Decisions (each compares at least two options)

| ID | Decision | Options | Why (2-3 lines) |
|---|---|---|---|
| H1 | NestJS 11.2.8 on `@nestjs/platform-fastify`, pinned | (a) Express adapter (b) Fastify adapter (c) plain Fastify | Fastify gives `inject()` for tests (no supertest), schema-free fast routing and server-level `bodyLimit`/`requestTimeout`. Nest keeps the module/guard/interceptor model the spec names. Plain Fastify would mean rebuilding DI and guard ordering by hand. |
| H2 | DTO validation: thin custom Zod layer, no `nestjs-zod` | (a) `nestjs-zod` (b) `@Contract({params, query, body, response})` + param decorators | Zod 4 ships `z.toJSONSchema`, so one decorator drives validation, explicit response serialisation (allow-list) and the OpenAPI document with ~150 lines and no extra dependency. `nestjs-zod` adds a dependency and swagger coupling for the same result. |
| H3 | OpenAPI generated from our own route registry, not `@nestjs/swagger` | (a) swagger + decorator metadata (b) registry → OpenAPI 3.1 | The registry already holds authz, idempotency, pagination and rate-limit metadata; emitting `x-authz`/`x-rate-limit`/`x-idempotency` from it keeps the generated file diffable against `docs/api/openapi.yaml`. Swagger needs `emitDecoratorMetadata` and still would not know our guards. |
| H4 | Route rules enforced at bootstrap (`auditRoutes`) and again in tests | (a) ESLint only (b) runtime audit + test (+ ESLint later) | An ESLint rule sees syntax; the audit sees the real route table (inherited decorators, dynamic modules). `createApp` refuses to start when any route lacks `@Public()`/`@Authorize()`, a rate limit, idempotency (mutations), pagination (list responses) or `@ReasonCode()` (REQUIRES_REASON_CODE actions). |
| H5 | Guard order: AccessToken → Policy → RateLimit → KillSwitch; interceptors Telemetry → Idempotency → Serialize | (a) rate limit first (b) after policy | `store`-keyed budgets must run after membership is proven, or any user could drain another store's budget with a forged `X-Store-Id`. Floods are first absorbed at the edge (Cloudflare); before policy the only work is an ES256 verify. |
| H6 | Seller principal is built **per request for the one store in `X-Store-Id`** | (a) all memberships in one Principal (b) scoped to the active store | `@outlet/policy` checks `storeIds` and `roles` independently, so (a) would let an owner of A acting in B (where they are `support`) use owner rights. (b) Not a member → 404; member without passkey `amr` → 403 `passkey-required`; wrong role → 403. |
| H7 | Market from path `/v1/{market}` (lower case, validated by `@outlet/markets-config`); DB market id = upper case | (a) header only (b) path, header optional | API-01: path routes to the cell and is cache-safe. `X-Market` is accepted only when it equals the path market (else 400) or on global routes. Contract C3: `eg` in URLs, `EG` in rows. Tokens are bound by audience `outlet:{market}`; another market's token → 401 `market-mismatch`. |
| H8 | Rate limiting: GCRA behind `RateLimiterPort`; in-memory and Redis (single Lua `EVAL`, server `TIME`) | (a) fixed window (b) token bucket (c) GCRA | GCRA stores one number per key, is burst-exact and atomic in one Lua call; fixed windows allow 2x bursts at the edge of a window. Keys: user, device, store, ip, asn. IP and ASN never stand alone (bootstrap check) and get a CGNAT multiplier (x10 / x100). Redis calls have a 50 ms timeout and a circuit breaker; each budget declares fail open (reads) or closed (writes, OTP, checkout). |
| H9 | Idempotency: global interceptor on every POST/PUT/PATCH/DELETE; opt-out only with `@NoIdempotency(reason)` for pure POSTs | (a) opt-in decorator (b) default-on | Default-on cannot be forgotten. Key must be a UUIDv7 whose timestamp is within ±24 h (else 400). Hash = canonical {method, route, path, query, body, store}. Replay sets `Idempotent-Replayed: true`; different hash → 422; in flight → 409. Any handler error abandons the key so a retry runs again. Authz is re-checked on replay (guards run first). |
| H10 | Pagination envelope `{ items, next_cursor }` (snake case, contract wins over the brief's `nextCursor`) | — | `docs/api/README.md` and every catalog DTO use `next_cursor`; the generated client must not see two spellings. |
| H11 | Problem+JSON: `type = urn:outlex:problem:{slug}` | (a) relative `/problems/x` (b) URN | The contract marks `type` as `format: uri`; a URN is an absolute URI without inventing a domain (none is provisioned, ADR-0002). Never a stack, message of an unknown error, or PII; `request_id` always present. |
| H12 | Tenant DB context per request: `req.ctx.db = {kind:"user"}` or `{kind:"store", storeId}` + `RequestDb.run(req, fn)` over the `outlet_app` client | (a) session-level `SET` (b) `SET LOCAL` per transaction | ADR-0011: PgBouncer transaction mode leaks session settings. Services that bind their own context (`@outlet/catalog`) receive the same principal and store id. |
| H13 | Store memberships behind `StoreMembershipPort`; default adapter is **Unconfigured → no memberships** (fail closed) | — | `store_members` is in the ERD but not migrated yet. Seller routes therefore 404 in production until that migration and its Pg adapter land. Tests use the in-memory adapter. |
| H14 | `/v1` versioning: explicit path prefix + `@Deprecated({ sunset })` emitting `Deprecation`/`Sunset`/`Link` | (a) Nest URI versioning (b) literal paths | Literal paths map 1:1 to the contract paths. The audit rejects a sunset less than 183 days after the deprecation date (T3: ≥ 6 months). |

## Request pipeline

1. Fastify `onRequest`: request id (incoming `X-Request-Id` if `^[A-Za-z0-9-]{8,64}$`, else UUIDv7), market (path, optional `X-Market`), child logger, security headers (`nosniff`, `no-referrer`, `DENY`, COOP/CORP, HSTS, `default-src 'none'` CSP, `Cache-Control: private, no-store` unless the route sets one). `bodyLimit` 1 MiB, `requestTimeout` 10 s, plus a 10 s handler timeout (RxJS) → 503 `timeout`.
2. Guards (H5). 3. Interceptors: telemetry (`withMarket` + `withSpan`), idempotency, serializer (response parsed by the contract schema, `Cache-Control`, deprecation headers). 4. Param decorators validate params/query/body (400 `validation-failed` with JSON pointers). 5. `ProblemFilter` maps everything (CatalogError, AuthError, Fastify `FST_*`, Nest `HttpException`, Zod) to Problem+JSON. 6. `onSend`: weak ETag on GET 200 + `If-None-Match` → 304.

## Route metadata (all required unless noted)

`@Contract({ operationId, summary, params?, query?, body?, response, status?, cacheControl?, maxQueries })` · `@Public()` **or** `@Authorize(action, resolver, { tenant: "user" | "store" })` · `@RateLimit({ budget, keys? })` or `@NoRateLimit(reason)` · `@Paginated()` (list responses) · `@ReasonCode()` (REQUIRES_REASON_CODE actions) · `@NoIdempotency(reason)` (pure POSTs only) · `@KillSwitch(name)` · `@Deprecated(...)` (optional).

## Threat notes (STRIDE, short)

- **Spoofing:** ES256 only, `kid` pinned, `aud = outlet:{market}`, 10-min tokens; public routes ignore credentials entirely (no mixed principals in caches).
- **Tampering:** strict Zod DTOs (unknown fields → 400); response allow-list serialisation; idempotency hash binds path and store.
- **Repudiation:** request id in every log line and problem; reason code captured for PII/financial reads (audit-log wiring is a TODO, see below).
- **Information disclosure:** not-owned = 404; Problem bodies never carry messages of unknown errors; logs via `@outlet/logger` (redacting); limiter keys are HMAC-hashed before reaching Redis.
- **DoS:** body 1 MiB, 10 s timeouts, GCRA per user/device/store, CGNAT-aware IP keys, breaker on Redis.
- **Elevation:** deny by default (audit + runtime 403 `no-policy-declared`), per-store principal (H6), passkey for seller routes, RLS context per transaction.

## Not done here (tracked)

`store_members` migration + Pg adapter; admin principal (`adminPasskeySession`; admin and system denials are tested at the policy level until HTTP can mint them); audit-log write of authz decisions and reason codes; failure-only counting for the gift-card budget; ESLint rules for the four route rules (runtime audit enforces them today); request cancellation: the 10 s handler timeout stops waiting but does not abort handler DB work (statement_timeout bounds it; AbortSignal plumbing through `req.ctx` is a TODO in `TelemetryInterceptor`); a real boot smoke test of `cli.ts` (it needs Postgres and Redis; `test/boot.test.ts` covers config, Node 24 `toCryptoKey` and pool tags only).

## Decision log

- **2026-11-08 (chief review D1):** the route audit walks the prototype chain (inherited handlers are served by Nest). `createApp` records Fastify's own `onRoute` registrations and refuses to start when the served set differs from the audited set in either direction.
- **2026-11-08 (D2):** `X-Device-Id` is optional on `@Public` routes whose budget fails open (SSR, crawlers, link previews): they fall back to the IP bucket (x10 CGNAT multiplier). Authenticated routes and fail-closed budgets (OTP, checkout) still answer 400 `device-id-required`.
- **2026-11-08 (D3):** store-tenant routes with object params must ship an `otherTenant` fixture (member of store A, store B's object, 404). Admin and system principals get policy-level denial cases per route.
- **2026-11-08 (D4):** idempotency lease. An `in_progress` key whose lease (`locked_until`, 60 s) expired is taken over by a same-hash retry (fresh again); a different hash is still 422; concurrent takeovers are serialised by the primary key and the re-checked WHERE. Uses the existing, previously unused `locked_until` column (data model: "in-flight lock"), so no migration is needed. Rows written before this change have NULL and expire as before.
- **2026-11-08 (D5):** `auth` and `worker` added to `PG_PROCESS_NAMES`; `cli.ts` builds an `auth`-tagged pool from `DATABASE_URL_AUTH` (required in production) for auth-core.
- **2026-11-08 (D6):** timeout does not cancel handler work; documented, TODO above.
