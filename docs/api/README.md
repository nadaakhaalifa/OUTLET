# Outlet NK API contract (Phase 1 skeleton)

Status: Draft for review · Date: 2026-10-10 · Spec refs: master prompt §T3, §A2.4, §A2.5, §A2.11, Part C sections 1-8, 14-15, 19-24, §9, §10 · File: `docs/api/openapi.yaml` (OpenAPI 3.1.0)

Naming: the master prompt says HAUL, the product is Outlet NK.

## What this is

A contract-first skeleton of the Phase 1 (MVP) REST API: 156 operations on 122 paths, 184 component schemas. No server implements it yet and no backend is deployed (owner decision 2026-10-10). The intended end state per §T3 is OpenAPI generated from the NestJS code; until then this file is the contract that Zod schemas, the generated mobile client and the Pact tests are written against.

The file is hand-maintained YAML. Re-validate after every edit:

```
node tooling/api/validate-openapi.mjs            # validates docs/api/openapi.yaml
node tooling/api/validate-openapi.mjs path.yaml  # validates another file
```

## Scope

Included: every endpoint the master prompt names in Part C sections 1-8, 15 (Phase 1 parts), 17, 19-24, plus the §9 price-integrity and §10 fit/size-profile endpoints that P3 puts in Phase 1.

Excluded on purpose, because P3 places them in Phase 2 or 3 (or ADR-0004 gates them):

| Master prompt | Endpoint | Why absent |
|---|---|---|
| §14 | `GET /v1/plus/plans`, `POST /v1/plus/subscribe`, `/cancel`, `/pause`, `/switch-plan`, `POST /v1/webhooks/{provider}/recurring` | HAUL Plus is Phase 2; billing path depends on ADR-0004 and Apple review |
| §15.1 | `POST /v1/gift-cards`, `/redeem`, `GET /v1/me/gift-cards`, `POST /v1/b2b/gift-cards/bulk` | Gift cards are Phase 2 |
| §15.4 | `GET /v1/creator/dashboard` | Creators are Phase 3 |
| §11, §12, §13 | stylist, budget, history endpoints | Phase 2 (not in the requested sections) |
| §5 | reviews and Q&A | no API named and not in the P3 Phase 1 list |
| §26 | analytics event ingestion | not in the requested sections |

Phase 1 store credit is read-only in the API (wallet balances and transactions) and spendable through checkout; there is no top-up, withdrawal or transfer endpoint by design (ADR-0003, §B2).

## Derived operations

74 operations carry `x-derived: true` and a description starting "Not named in the master prompt". The master prompt gives no API list for sections 19 (Seller Center), 23 (Admin) and 24 (Notifications), and several flows (addresses, age attestation, order list, favourite-store seen, wishlist sharing) need a path the spec never names. Each derived operation is traceable to a stated flow or rule through `x-spec-ref`. They are proposals for owner review, not decisions.

## Conventions

### Versioning and servers
- Every path starts with `/v1`. Deprecations use `Deprecation` and `Sunset` headers at least 6 months ahead (§T3).
- The server URL is a placeholder under the reserved `.invalid` TLD.

### Money
`Money = { amount: string, currency: "EGP" }`. `amount` is integer minor units (piastres) as a decimal string matching `^-?[0-9]{1,18}$`, because JSON numbers cannot carry a `bigint` safely. Zod converts to `bigint` at the boundary (same rule as `docs/specs/money-and-ledger.md`). Floats are never used. Percentages that are not money are integers (`discount_pct`) or basis points (`*_bp`). The validator flags any money-looking property typed as a number.

### Authentication
Security schemes, declared per operation (there is no global default, so an omission cannot silently inherit):

| Scheme | Type | Use |
|---|---|---|
| `shopperBearer` | HTTP bearer JWT | Shopper app; 10 minute access token, audience scoped, carries `amr` |
| `sellerBearer` | HTTP bearer JWT | Seller Center; store scoped; passkey/TOTP mandatory |
| `adminBearer` | HTTP bearer JWT | Admin Console; passkey, SSO and device posture |
| `serviceBearer` | HTTP bearer JWT | Internal calls (`/v1/promotions/evaluate`), never issued to clients |
| `appAttest` | API key header `X-App-Attest` | App Attest / Play Integrity; required on OTP, refresh, checkout |
| `webhookHmac` | API key header `X-Signature` | Provider webhooks: HMAC over raw body + timestamp ±5 min + IP allow-list |

Public operations use `security: []` and must set `x-scope: [public]`. Only three are public: price history, price evidence, shared wishlist view. Sign-in routes are protected by `appAttest` plus rate limits instead.

Webhook header names and algorithms are provider specific. They are **VERIFY BEFORE LAUNCH** per adapter and are not specified here.

### Vendor extensions

| Extension | Where | Meaning |
|---|---|---|
| `x-scope` | operation | Required scope(s), `<audience>:<resource>.<read\|write>`; `public` for open routes. Enforced by the central policy guard; deny by default |
| `x-idempotent` | operation | `true` = money, stock or order write that requires `Idempotency-Key` (24 h replay). `false` = naturally safe or non-money write; header accepted, optional |
| `x-rate-limit` | operation | List of `{limit, window_seconds, key, source}`. `source: spec` means the master prompt states the value; `proposed` means a default to be tuned by load tests |
| `x-pii-class` | operation | Highest PII class handled: P0 public, P1 internal, P2 personal, P3 sensitive (field-encrypted). Per-field `x-pii-class` appears on schema properties |
| `x-phase` | operation | Delivery phase (all 1 here) |
| `x-spec-ref` | operation | Master prompt section or local spec the operation comes from |
| `x-derived` | operation | Not named in the master prompt (see above) |
| `x-webhook`, `x-dedup-key` | operation | Inbound webhook and the provider event id used for dedup |
| `x-dual-approval` | operation | Needs a second, different approver (payouts, large refunds) |
| `x-requires-reason-code` | operation | PII view must carry a reason code and is audit-logged |
| `x-internal` | operation | Exclude from the public generated client |
| `x-etag` | operation | GET returns `ETag` and honours `If-None-Match` |

### Idempotency
- Header `Idempotency-Key`: client-generated UUIDv7. Server stores `(key, route, actor, request_hash, response)` for 24 h (§A2.5).
- Replay returns the stored response with `Idempotent-Replayed: true`.
- Same key with a different request hash returns `422` (problem type `idempotency-key-reuse`). A concurrent in-flight request with the same key returns `409`.
- The validator requires every write operation to declare the header (required when `x-idempotent: true`, optional otherwise).
- **Deviation:** the two inbound webhook operations do not declare `Idempotency-Key`, because providers do not send one. They declare `x-dedup-key` instead (provider event id, `payment_events_raw.event_id UNIQUE` / `courier_events_raw`). The validator enforces `x-dedup-key` and the HMAC scheme on them.
- `POST /v1/checkout` also uses the key as the PSP intent key (saga step 4).

### Errors
All errors are `application/problem+json` (RFC 9457): `type`, `title`, `status`, `detail`, `code`, `request_id`, and `errors[]` with JSON Pointers on 400. Bodies are generic in production (no stack traces). Mapping:

| Status | Meaning |
|---|---|
| 400 | Zod validation failure |
| 401 | Missing/expired token, bad webhook signature |
| 403 | Wrong audience, missing scope, age gate, attestation failure |
| 404 | Unknown **or not owned / other tenant** (never 403 for object access) |
| 409 | Invalid state transition, blocked deletion, in-flight duplicate key |
| 412 / 428 | `If-Match` mismatch / missing |
| 422 | Semantic failure, idempotency key reuse, return not eligible |
| 429 | Rate limit, with `Retry-After` and `RateLimit-*` |
| 503 | Dependency down or kill switch active |

### Pagination
Cursor only. `?cursor=<opaque>&limit=1..50` (default 20, max 50 per API4). Responses are `{ items, page: { next_cursor, has_more } }`. Search additionally allows at most 30 facets.

### ETags
Detail `GET`s marked `x-etag` return `ETag`; clients revalidate with `If-None-Match` (304). Updates to mutable resources require `If-Match` (412 on mismatch, 428 when missing) to prevent lost updates.

### Rate-limit headers
Every 2xx and 429 carries `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset` (seconds); 429 and 503 add `Retry-After`. Counters are Redis token buckets keyed by user, device, IP, phone or provider as listed in `x-rate-limit`.

### Mass assignment and serialisation
- Request schemas are closed (`additionalProperties: false`); the validator fails any request object that is not.
- There is no seller-supplied reference price. Clients can never send `vrp`, `tier`, `discount_pct`, `badge`, `trust_level`, `status` of an order or a total (docs/specs/price-integrity.md §6).
- Response schemas are explicit allow-lists; seller order views mask buyer PII (relay phone).

### Localisation
Arabic first. Send `Accept-Language: ar-EG` (default) or `en`. User-visible text fields use `LocalizedText { ar (required), en }`. Stable `code` values let the client localise errors.

## Validator

`tooling/api/validate-openapi.mjs` uses the root `@apidevtools/swagger-parser` (structural validation and `$ref` resolution) and `yaml`, then enforces these rules:

1. OpenAPI 3.1.x; every path under `/v1/`.
2. `operationId` present, unique, camelCase.
3. Operation-level `security` present; empty only with `x-scope: [public]`; every scheme exists.
4. `x-scope`, `x-idempotent`, `x-rate-limit` (with `source`), `x-pii-class` (P0-P3) present and well typed.
5. Every write method (POST/PUT/PATCH/DELETE) declares `Idempotency-Key` (required iff `x-idempotent`), except webhooks which need `x-dedup-key` and `webhookHmac`; idempotent writes declare 409; writes declare 422.
6. Every operation declares 429 and a `default` Problem response; every 4xx/5xx is a shared `$ref` to a Problem response.
7. ETag GETs declare 304, `If-None-Match` and an `ETag` response header; `If-Match` operations declare 412 and 428.
8. 2xx responses expose `RateLimit-*` headers; paginated operations accept `limit` with maximum 50.
9. Request object schemas are closed.
10. No money-looking property typed as a number.

Exit code is non-zero on any failure. Unused component schemas are reported as a warning.

## Not verified here

- Provider specific bodies (payment, BNPL, courier, ETA) are intentionally absent; the `Webhook` schema is an open object. **VERIFY BEFORE LAUNCH** per adapter.
- Installment fields are shaped for provider quotes; provider APIs and marketing rules are unverified.
- Legal fields (seller legal identity, retention windows, return windows) are shaped, not confirmed. See the master prompt P2 register.
- OrderGroup status values and Return status values are a proposed projection and must be reconciled with `packages/domain` state machines before freezing.
- Rate limits marked `source: proposed` are defaults, not measured.
