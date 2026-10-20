# Dashboard foundations (Phase A): identity, integrity, time series, publishers, rollups

Status: **spec only, not built.** Date 2026-10-16. Author: architect. **Amended 2026-10-16 after the chief-reviewer security and privacy review** (blockers B1-B3, high H1-H5, medium M1-M9, low L1-L5). Section 0.1 records the code facts checked for the review, section 10 lists the owner and counsel decisions, section 11 maps every review item to the section that addresses it, and section 12 lists the contract deltas for the Wave 0 builder. Source brief: `reports/Seller and admin dashboards benchmark.md` sections 3, 4.3, 5, 6, 8 (Phase A table) and 9, plus the research notes in `research_notes/Seller and admin dashboards benchmark/`.
Master prompt refs: A2 (rules), A3 (template), 19, 19.1, 23, T4, T5, T8, B1, 26.
ADRs: [0045](../adr/0045-dashboard-metrics-read-path.md), [0046](../adr/0046-ledger-integrity-result-store.md), [0047](../adr/0047-analytics-time-zone-and-display.md), [0048](../adr/0048-admin-identity-and-posture.md), [0049](../adr/0049-dashboard-role-permissions.md), [0050](../adr/0050-openapi-paths-without-controller.md), [0052](../adr/0052-gated-breakdowns-external-margins-and-pinned-releases.md) (Proposed; amends 0045 decision 4).
VERIFY rows: VR-01, VR-AC-01, VR-AC-02, VR-AC-04, VR-DB-01 (existing), VR-DASH-01 to VR-DASH-04 (existing), VR-DASH-05 to VR-DASH-08 (added with the review amendment).

Scope: the seven tracks the brief names. Out of scope here (they are separate Phase A items in the benchmark): `packages/ui-web`, the chart spike under production CSP, and web performance budgets. Nothing in this spec moves money, changes a ledger posting, grants a new role or changes a payout, VAT or display decision. Where a track would need one of those, it records a Proposed ADR or a VERIFY row and builds the safe default.

Conventions used below
- Wire format is snake_case (repo convention: `freshness_at`, `includes_suppressed`). The brief's logical names map as `asOf` to `as_of`.
- Money is integer piastres, `bigint` in TS, `BIGINT` in Postgres, and a base-10 integer **string** on the wire (as `amount_minor` elsewhere). Counts and basis points are JSON integers.
- "Gate" means the server-side authorization function that a route runs. The API is always the authority; web navigation only hides.
- PII classes: P0 public, P1 internal, P2 personal, P3 sensitive.
- Tiers per `~/.claude/CLAUDE.md`: B = builder (Sonnet), T = tester (Sonnet), CR = chief-reviewer checkpoint.

---

## 0. What exists today (read in the repo, 2026-10-16)

| Fact | Evidence |
|---|---|
| `GET /v1/admin/me` has no controller; admin-web calls it and treats failure as `roles: null`, posture `unknown`, all writes disabled | `apps/admin-web/src/api/client.ts:100`, `server/console.ts:91-102`, `view-models/posture.ts:14-21`, VR-AC-01 |
| Admin effective roles are already computed server-side: standing grants (unexpired) plus live elevations; standing `super_admin` counts only during break-glass | `apps/api/src/modules/admin/domain/access.ts:18-46` (`computeAccess`) |
| Route role allow-lists live in `ROUTE_ROLES`; the ledger read API has its own gate (standing `finance` grant plus passkey, audit every decision, fail closed on audit failure) | `admin/domain/access.ts:52-60`, `ledger/adapters/ledger.controller.ts:38-66` |
| The access token carries `amr` (`otp_sms`, `otp_whatsapp`, `apple`, `google`, `passkey`, `email_link`, `attestation`, `webauthn`, `totp`); the policy actor carries `assurance: basic or passkey`; a wrong audience is 401 | `packages/auth-core/src/access-token.ts:11-27`, `packages/policy/src/types.ts:40`, `platform/policy.guard.ts:43` |
| admin-web uses a hard-coded install id `00000000-0000-4000-8000-000000000000` for every browser | `apps/admin-web/src/server/console.ts:65`, `proxy.ts:30` |
| **`GET /v1/seller/me` already exists** and returns `{user_id, memberships[{store_id, role}]}` from token grants; OpenAPI `SellerMe` exists; seller-web's onboarding client calls it, but `Shell.tsx` and `page-context.ts` still hard-wire `role: null` | `apps/api/src/modules/seller-analytics/adapters/seller-me.controller.ts`, `docs/api/openapi.yaml:24260, 32688`, `apps/seller-web/src/api/onboarding-client.ts:127`, `components/Shell.tsx:8-11`, `page-context.ts:11-14` |
| Seller role vocabulary disagrees: policy and seller-settings use `owner, manager, catalog, warehouse, finance, support`; seller-web `teamRole` and OpenAPI `TeamMember` use `fulfilment` and lack `support`; seller-web nav is keyed on the web vocabulary | `packages/policy/src/types.ts:12`, `packages/domain/src/seller-settings/team.ts:3`, `apps/seller-web/src/api/schemas.ts:232`, `openapi.yaml:38041-38048`, `seller-web/src/view-models/nav.ts:9-27` |
| `IntegrityJob.run()` returns `{ok, trialBalance, chain, storeCredit{drift, negative}}` and **nothing persists it**: the scheduler keeps job state in memory, the module has no alert port, and the registry text "writes only alerts and the signed snapshot" is not backed by code | `ledger/application/integrity-job.ts:13-83`, `ledger.module.ts:72-77`, `workers/scheduler.ts:99-134`, `workers/registry.ts:57-58` |
| `audit_log` is hash-chained per `chain_id` with `audit_log_verify(chain_id)` and `audit_chain_checkpoints`; policy rule `audit_log.read` allows `dpo, security, super_admin`; `/v1/admin/audit-log` is OpenAPI-only | `packages/db/migrations/0005_audit_log.sql`, `packages/policy/src/rules.ts` (`audit_log.read`), `openapi.yaml:10224` |
| Seller analytics: append-only `seller_analytics_facts` with `shopper_key`, query-time aggregation, `K_ANONYMITY_MIN = 50`, `kAnonymizeAdditive` (fold suppressed cells into the smallest released cell), windows snapped to **UTC** days, max 366 days | `0028_seller_analytics.sql`, `docs/specs/seller-analytics.md`, `packages/domain/src/seller-analytics/kanon.ts:60-94` |
| Production event source is `unconfigured("analytics.warehouse")`; only some event types have relay consumers; unrouted events are acknowledged and stay replayable in `outbox_events` | `apps/api/src/production/ports.ts:163-168`, `production/relay.ts:14-61`, `docs/specs/commerce-events.md` |
| There is no first-party client analytics ingest endpoint; the client tracker writes to a port | `research_notes/.../repo_api_data.md` section 1 |
| Africa/Cairo helpers exist (`cairoParts`, `cairoLocalToUtc` resolves a skipped local time forward) | `apps/api/src/workers/cairo.ts` |
| Retention: `analytics_events` rule is 25 months, but only `user_events` is purged; `seller_analytics_facts` (with P2 `shopper_key`) is listed under the same rule in `data_inventory.yaml` and is **not purged** by any job. The catalog text "The remaining tables are aggregates or not personal" is **wrong** for the facts table (P2 `shopper_key`, P2 `term`) and is corrected by track 6 | `apps/api/src/modules/retention/domain/catalog.ts:76`, `docs/privacy/data_inventory.yaml:3844-3866` |
| Highest migration `0087`; `0058` and `0073` reserved-unused; `packages/db/migrations/RESERVED` must be empty on merge. Highest ADR `0051` (0042 unused) | directory listings |

### 0.1 Facts checked for the security and privacy review (2026-10-16)
The review listed items it could not verify. Each was read in the code; the design consequence is folded into the track named.

| # | Question | Finding (file:line) | Design consequence |
|---|---|---|---|
| F1 | Is `app.role = 'admin'` set by admin adapters; which RLS convention is in use? | **No.** `app.role` takes one value from the closed list `DB_ROLES` (`customer, seller, ops, finance, trust_safety, support, marketing, dpo, security, super_admin, courier, creator, system`, `packages/db/src/session-context.ts:8-22`); `sessionSettings` throws on any other value (`:76-78`). Policies name concrete roles, e.g. `ledger_entry_chain` SELECT `app_role() IN ('finance','super_admin','system')` (`packages/db/migrations/0031_ledger_posting.sql:34-35`), `audit_log` SELECT `('dpo','security','super_admin')` (`0007_rls_and_grants.sql:132-133`). Ledger reads run under `asSystemRole` after the HTTP gate (`apps/api/src/modules/ledger/adapters/kysely-store.ts:113`, `platform/db/session.ts:65-74`) | Every RLS sketch in this spec that said `'admin'` is rewritten to concrete role names (tracks 3, 6) |
| F2 | Does a passkey assertion with platform `web` create a device row? | **No, and admin sign-in cannot succeed against the real API today.** admin-web sends `device: {platform: "web", install_id}` (`apps/admin-web/src/session/api-session.ts:43`); the API's `DeviceSchema` accepts only `ios, android` (`apps/api/src/modules/auth/adapters/http-common.ts:9-16`), so the request is 400 before any row is written. Even with `web` accepted, `attestationFrom` returns null for a non-mobile platform (`http-common.ts:25-30`) and `assert` answers `attestation_failed` (`application/passkeys.ts:126-127`). `devices.platform` and `auth_sessions.platform` CHECKs admit only `ios, android` (`0006_identity_consent.sql:44`, `0047_auth_hardening.sql:29`). Existing row VR-AC-02 | Track 1 adds an expand migration and a web assertion branch (section 1, "Session binding") |
| F3 | Where does `ctx.requestId` come from? | **Client-controlled when well-formed.** `buildRequestContext` keeps an inbound `X-Request-Id` that matches `SAFE_REQUEST_ID`, otherwise mints a UUIDv7 (`apps/api/src/platform/request-context.ts:37-45, 61`) | The edge posture MAC binds to an edge-minted id; the edge overwrites `X-Request-Id`; single-use replay set (section 1, M6) |
| F4 | Is `audit_log` partitioned? | **No.** Plain `CREATE TABLE audit_log` (`0005_audit_log.sql:14`); indexes on `(target_type, target_id, occurred_at)` and `(actor_id, occurred_at)` plus `UNIQUE (chain_id, seq)` (`:32, 35-36`). The retention catalog text "rows leave only by monthly partition detach" (`retention/domain/catalog.ts:80`) describes a design that is not built | 0091 keyset indexes stay `CONCURRENTLY` on a plain table; audit partitioning is recorded as a gap (section 7.1), not built here |
| F5 | Are `requireFinance` and the tax `WRITERS` predicates exportable? | **Not today.** `requireFinance` is a private controller method (`apps/api/src/modules/payouts/adapters/payouts.controller.ts:197-200`) that calls the static `FinanceAccess.isFinance` (`payouts/adapters/access.ts:79-83`); `FinanceAccess` is not exported from `payouts/index.ts`. The approve route is decorated with policy `payout` **read** (`payouts.controller.ts:230-237`) and dual approval is checked in the use case through approval records (`access.ts:50-55` comment, ADR-0021 point 7). Tax `READERS = [finance, ops, super_admin]` and `WRITERS = [finance, super_admin]` are module-private constants (`tax-eta/adapters/tax-eta.controller.ts:62-63`); `requireAdmin` counts **standing** `super_admin` without break-glass (`:100-125`), unlike `computeAccess` | Track 1 exports pure predicates (`isFinanceActor`, `canReadTax`) through each module's `index.ts`; capability tests run at HTTP-route level (section 1, H1). The tax super_admin inconsistency is ADR-0049 item 9 |
| F6 | What is the scope of the search-term normaliser? | `SourceEventSchema.term` (`apps/api/src/modules/seller-analytics/domain/ports.ts:18-31`): NFKC, lower-case, whitespace collapse, length 2-60, rejects runs of 6+ digits (Western, Arabic-Indic, Extended) and `@ / \ http: www.`. **No name detection.** The privacy module has **no** name heuristic for DSAR redaction (no match in `apps/api/src/modules/privacy/**`); the only scrubber is `llm-gateway/domain/scrub.ts` (email, URL, phone, long digits). Terms are stored raw in `seller_analytics_facts.term` (`0028_seller_analytics.sql:29`) | Track 5 replaces "reject names" (no heuristic exists to reuse) with a catalogue-vocabulary allow-list plus a keyed hash for everything else (section 5, M9) |
| F7 | Is there a Prometheus and alerting stack in `infra/observability`? | **Partly.** Rule files and promtool fixtures exist (`infra/observability/prometheus/rules/*.rules.yaml`, `prometheus/tests/*.test.yaml`; `absent_over_time` already used in `slo-checkout-success.rules.yaml:100`). promtool runs only in `tooling/infra/verify.sh:38-39`; **CI does not run it** (`.github/workflows/ci.yml` has terraform, conftest and checkov steps only). No Alertmanager or on-call routing config exists in the repo. The API exports metrics by **OTLP push** every 15 s and is a no-op without `OTEL_EXPORTER_OTLP_ENDPOINT` (`apps/api/src/platform/telemetry/bootstrap.ts:41-66`); observable gauges are supported (`telemetry/metrics.ts:103`) | Track 3 adds a CI promtool step and records alert delivery (routing, on-call) as a launch blocker (section 3, H5) |
| F8 | Who calls `/v1/seller/analytics/summary` in mobile Brand mode? | `apps/mobile/src/features/brand-mode/api.ts:119` calls `getSellerAnalyticsSummary({query: {from: today, to: today}})` (Cairo **dates**, not instants) and reads `freshness_at`, `gmv`, `orders`; it runs in one `Promise.all` with `getSellerBalance()` (`:120`), also unserved, so the whole Brand-mode dashboard fails today. The store id comes from `sellerMe().memberships[0]` (`:105-109`) | The store-scoped summary is not a drop-in replacement (different shape and window type); replacing the old path is a **product sign-off** (ADR-0050, L5) |
| F9 | Store status vocabulary for `store_status` | `stores.status IN ('DRAFT','ACTIVE','PAUSED','SUSPENDED')` (`0013_stores.sql:26-27`); the spec's `active, suspended, deactivated, onboarding` did not exist | `SellerMembership.store_status` becomes `draft, active, paused, suspended` (section 2, M8) |
| F10 | Facts table write rights and pseudonym derivation | `seller_analytics_facts` grants `SELECT, INSERT` only and the insert policy is `system` (`0028:63-68`): no UPDATE or DELETE path exists for purge or erasure. Shopper pseudonyms are derived, not stored: `HMAC(key, "pseudonym:v1:<UTC year>:<userKey>")` (`packages/analytics/src/pseudonym.ts:90-100`) | Track 6 adds system-only purge and erasure grants and computes every live key for erasure (section 6, H3) |
| F11 | Legacy shopper-gated reads | Every legacy route snaps to UTC days through `snapToDays` (`seller-analytics/application/queries.ts:49`, `packages/domain/src/seller-analytics/kanon.ts:87-94`); `traffic.by_source` and `geography` use the fold rule (`queries.ts:120, 248`); `unique_visitors` is returned with no k gate (`queries.ts:62`, `adapters/wire.ts:62`) | B1, B2, M5 (section 4) |

---

## 1. Track 1: `GET /v1/admin/me` (closes VR-AC-01)

### Flow
1. admin-web `getConsole()` calls `GET /v1/admin/me` once per request (React `cache`), as today.
2. API: guard checks admin audience, signature, expiry, session not revoked, actor active. Controller loads live elevations for the actor (existing elevations port), computes `computeAccess(actor, elevations, now)`, evaluates posture from server-side signals (section 1 Rules), computes the capability map with the **same predicates the route gates use**, and returns the document.
3. admin-web parses it with Zod, derives nav (`navFor(roles)`), posture (`evaluatePosture(me)`) and per-page write enablement, and renders the role and elevation chips in the top bar.

### Rules
- **No role ever comes from the client.** Roles, assurance, posture and capabilities are computed from the verified token, the database (grants, elevations, sessions, devices) and the signed edge header only. The query schema is a strict empty object: any query parameter is 400. Request headers other than `Authorization`, the request id, the signed edge posture header and `X-Admin-Install` (compared only against the hash stored for the session's device) are ignored.
- **Readable with standing roles only.** `me` requires an admin-audience token and at least one unexpired standing admin grant. It never requires an elevation. An admin-audience actor with zero admin grants gets 403 `not_admin`.
- `roles` = `computeAccess().effective`; `standing_roles` = `computeAccess().standing`. Standing `super_admin` appears in `standing_roles` but not in `roles` unless break-glass is live (existing rule, unchanged).
- `assurance` is derived from the token `amr`: contains `passkey` or `webauthn` gives `passkey`; else contains `totp` gives `totp`; else `otp`. It must agree with the policy actor's `assurance` (property test).
- **Posture is fail closed** (ADR-0048, Proposed for the signal sources):
  - `ip_allowlisted` is true only when the request carries a valid `X-Outlet-Edge-Posture` header (M6):
    - Format `v1.<kid>.<base64url(payload)>.<base64url(mac)>`, payload `{v:1, kid, ip_allowlisted, ts, request_id}`, MAC = HMAC-SHA256 over the exact payload bytes. `kid` selects the key from Secrets Manager (`ADMIN_EDGE_POSTURE_KEYS`, a map of at most 2 active kids so a rotation overlaps; an unknown `kid` is `invalid`).
    - The MAC is compared with `crypto.timingSafeEqual` on equal-length buffers (length mismatch is `invalid` without comparing). `ts` within 60 s of server time.
    - **The request id is minted by the edge.** `ctx.requestId` is client-controlled today (finding F3), so the edge overwrites `X-Request-Id` with its own UUIDv7 on every request and the MAC binds to that value; the API requires `payload.request_id === ctx.requestId`. The API also records `(kid, request_id)` in a single-use replay set (Redis `SET NX EX 120`); a repeat is `invalid`, and Redis unavailable gives `false` (fail closed).
    - **Topology requirement (Infra, VR-AC-04):** the API listener is reachable only from the edge (private subnet; security group or network policy admits only the edge or load balancer), and the edge **strips any inbound `X-Outlet-Edge-Posture`** before adding its own. A boot check refuses to start in production if `ADMIN_EDGE_POSTURE_KEYS` is set but `ADMIN_API_PRIVATE_INGRESS_ATTESTED` (set by the infra pipeline) is not, so a key is never trusted on a publicly reachable listener.
    - Missing keys, missing header, bad MAC, unknown kid, stale ts, wrong request id or replay all give false with `ip_allowlist_source: "not_configured"` or `"invalid"`. This stays the safe default until VR-AC-04 names the edge.
  - `device_trusted` (H1) is **false in Phase A for every session** with `device_source: "not_configured"`, because no real device-posture source exists (VR-AC-04: MDM, posture vendor or mTLS). It becomes true only when such a source is configured and attests the device. Sensitive console writes that need device trust therefore stay disabled until VR-AC-04 is answered; the API keeps enforcing its own gates.
  - `session_binding` (new, informational, honest name for what Phase A can prove): `passkey_uv_browser_bound` when the session was opened by a WebAuthn assertion with user verification (UV) persisted on the session **and** the request presents the server-minted browser install token that matches the session's device row **and** the device is not revoked; otherwise `passkey_uv_unbound`, `not_passkey` or `revoked`. It is **not** device trust: the install token lives in the same browser cookie jar as the session cookie, so theft of the jar steals both. It is shown in the console and may feed a later rule, but no write is enabled by it alone.
  - Development only: `ADMIN_POSTURE_DEV_TRUST=1` sets `ip_allowlisted` and `device_trusted` true (sources `dev_override`) when `NODE_ENV !== "production"`; production boot refuses to start with it set (boot test).
- Capabilities (closed key set, version 1). Each value is computed by calling the exported pure predicate that the matching route gate calls. A capability being true never implies a dual approval has been obtained.

| Capability | Gate it mirrors | Today's rule |
|---|---|---|
| `console.access` | policy `admin_console.access` | any effective admin role |
| `flags.read` / `flags.write` | `ROUTE_ROLES.flagsRead` / `flagsWrite` | ops, security, super_admin / ops |
| `pii.view` | `ROUTE_ROLES.piiView` | support, trust_safety, dpo |
| `kyc.read` / `kyc.write` / `kyc_review.read` | `ROUTE_ROLES.kyc*` | as in `access.ts` |
| `elevations.admin` | `ROUTE_ROLES.elevationsAdmin` | security, super_admin |
| `ledger.read` | `LedgerController.gate` | **standing** finance grant plus passkey |
| `ledger.integrity.read` | track 3 gate | same as `ledger.read` (ADR-0049 default) |
| `audit_log.read` | policy `audit_log.read` | dpo, security, super_admin (effective) |
| `payout.read` | policy `payout.read` (the `@Authorize` on every admin payout route) | finance, ops |
| `payout.approve` | **the HTTP route gate as built**: policy `payout.read` allow (`@Authorize` action `read`, `payouts.controller.ts:230-233`) **and** `isFinanceActor` (today `FinanceAccess.isFinance`, called by the private `requireFinance`, `:197-200, 237`), exported as a pure predicate from `payouts/index.ts`. Dual approval is checked later in the use case and is never implied | finance (live grant) |
| `refund.approve` | policy `refund.approve` | finance |
| `plan_price.update` | policy `plan_price.update` | finance |
| `data_export.create` | policy `data_export.create` | dpo |
| `privacy.read` (new) | DPO console gate (`privacy/adapters/dpo.controller.ts:54-57`: unexpired `dpo` grant plus passkey), exported as `canReadPrivacyConsole` | dpo |
| `recon.read` (new) | `ReconAccess.require` = policy `payout.read` (`reconciliation/adapters/access.ts:21-25`), exported as `canReadReconciliation` | finance, ops |
| `tax.read` (new) | tax `requireAdmin(READERS)` (`tax-eta/adapters/tax-eta.controller.ts:62, 100-125`: unexpired grant in `finance, ops, super_admin` plus passkey), exported as `canReadTax` | finance, ops, super_admin (**standing** super_admin counts here, unlike `computeAccess`; reported faithfully, ADR-0049 item 9) |
| `brand_review.read` (new) | brand review gate (`admin/brand-review/brand-review.controller.ts:171`: at least one standing grant and an effective role in `BRAND_REVIEW_ROLES = [ops, trust_safety]`, `brand-review/domain.ts:51`), exported as `canReadBrandReview` | ops, trust_safety |
| `attention.read` | track 7 gate | any effective admin role (items filtered per capability) |
| `metrics.read.counts` / `metrics.read.money` | track 4 admin gate | ADR-0049 default: ops and finance / finance |

- Modules whose gates are not yet exported as a pure predicate (subscriptions, drops, ads, creators) are **not** in version 1. Adding a capability is additive and requires exporting that module's predicate first; the nav keeps its role table (VR-AC-05) for those areas. The four new keys above (`privacy.read`, `recon.read`, `tax.read`, `brand_review.read`) require the predicate exports listed, done in the track 1 PR (each is a move of existing code to a pure function, no rule change).
- **Capability equality is tested at the HTTP route, not only at the predicate** (H1). A pure-predicate test cannot catch drift where a route adds a check inside the handler (payout approve calls `requireFinance` inside the handler, after the decorator). For every capability, the test boots the Nest app with fake use cases and, for random actors, asserts `capability === true` iff the mirrored route returns a non-403 status (2xx, 404 or 409 from the fake). The route list per capability is a committed table; a new admin route with `admin_api` audience and no row in the table fails the test.
- No audit row on an allowed `me` (it is read on every page render and carries no third-party data; L1); every deny is audited through `AuditSink` with `ruleId: "admin.me"`. Every request increments `outlet.admin.me.requests{outcome=allow|deny|unavailable}` (L2).
- `Cache-Control: no-store`. No ETag. Rate limit 120 per 60 s per user (same as the proposed OpenAPI entry for siblings).

### Edge cases
- Elevation expires between `me` and the next action: `me` shows `elevation.live[].expires_at` and `next_expiry_at`; the console re-reads on navigation; the route gate decides at action time (the console never caches capabilities beyond one request).
- Grant with `expiresAtMs <= now` is excluded at the exact millisecond (existing `computeAccess` rule).
- Break-glass live with standing `super_admin`: `roles` includes `super_admin`, `elevation.break_glass_live: true`.
- Clock: `server_time` lets the console render countdowns from server time (existing `deviceNowMs` drift handling).
- Actor suspended mid-session: guard answers per existing behaviour (no change).
- Elevations port unavailable: 503 `elevations_unavailable` (never compute `roles` from standing only, which would hide a live elevation the user relies on; never return a partial document).

### Session binding for admin-web (H1; closes the technical part of VR-AC-02)
Today an admin cannot sign in against the real API at all (finding F2). The minimum honest fix, built in track 1 before `me`:

1. **Expand migration `0092_web_sessions.sql`** (new number, see migration plan):
   - `devices.platform` CHECK becomes `IN ('ios','android','web')`; `auth_sessions.platform` CHECK likewise (drop and re-add the named constraint `NOT VALID`, then `VALIDATE`; existing rows already satisfy it).
   - `auth_sessions.uv boolean NOT NULL DEFAULT false`: set true only by the passkey assertion path, after the verifier has checked the UV flag (the verifier already uses `requireUserVerification: true`, `auth/adapters/webauthn-verifier.ts:72, 110`; persisting it makes the fact independent of a later verifier config change). The legacy single-valued `sessions.amr` CHECK (`0006:75`) is not touched; posture reads `auth_sessions` only.
   - `devices.install_secret_hash bytea CHECK (install_secret_hash IS NULL OR length(install_secret_hash) = 32)`: SHA-256 of the server-minted browser install token, `web` rows only. `install_id` for a `web` row is a server-minted UUIDv4 (never client-supplied).
2. **Web assertion branch.** `POST /v1/auth/passkey/assert` accepts `device.platform: "web"` with **no** `install_id` in the body (a client value is ignored). For `web`: no App Attest (not applicable to browsers; the WebAuthn origin check against the configured admin origin is the binding); the credential's user must hold at least one unexpired standing admin grant, else 403 `web_sign_in_not_allowed` (shopper web is Phase 3 and out of scope); the shopper age gate is not consulted (staff are age-checked in KYC and HR, not by device; Security to confirm under VR-AC-02). The server mints a 256-bit install token, stores its hash on a new `devices` row, opens the session with `uv = true`, and returns `install_token` once in the response. **Rotated at every login**: the previous `web` device row of that user and browser is revoked.
3. **admin-web** stores the token in `__Host-admin-install` (httpOnly, Secure, `SameSite=Strict`, `Path=/`, no `Domain`), never exposes it to page script, and sends it to the API as `X-Admin-Install` on refresh and on every admin call made by the Next server. The shared constant install id (`server/console.ts:65`, `proxy.ts:30`) is removed.
4. `/v1/auth/refresh` for a `web` session requires `X-Admin-Install` whose hash matches the session's device row; mismatch is 401 and revokes the family (same as refresh-token reuse).
5. This is a CR checkpoint (auth) because it adds a sign-in path without device attestation.

### Data
New columns only (migration 0092 above). Reads: token claims, `admin_elevations` (0029), `auth_sessions` and `devices` (0006, 0047, 0092). PII: response is P1 (own user id, own roles). The edge header value and the install token are never logged; the install token hash is P2 (device identifier) and gets a `data_inventory.yaml` entry.

### API
`GET /v1/admin/me` · audience `admin_api` · scope `admin:read` · not idempotent (read) · 120/60 s per user · P1.

```yaml
AdminMe:
  type: object
  additionalProperties: false
  required: [user_id, roles, standing_roles, assurance, amr, posture, elevation, capabilities, server_time, session_expires_at, version]
  properties:
    version: { type: integer, enum: [1] }
    user_id: { $ref: "#/components/schemas/Uuid" }
    roles: { type: array, items: { $ref: "#/components/schemas/AdminRole" }, description: "Effective: standing (minus super_admin) plus live elevations" }
    standing_roles: { type: array, items: { $ref: "#/components/schemas/AdminRole" } }
    assurance: { type: string, enum: [passkey, totp, otp] }
    amr: { type: array, items: { type: string, enum: [otp_sms, otp_whatsapp, apple, google, passkey, email_link, attestation, webauthn, totp] } }
    posture:
      type: object
      additionalProperties: false
      required: [ip_allowlisted, device_trusted, ip_allowlist_source, device_source, session_binding]
      properties:
        ip_allowlisted: { type: boolean }
        device_trusted: { type: boolean, description: "False in Phase A: no device-posture source is configured (VR-AC-04)" }
        ip_allowlist_source: { type: string, enum: [edge_attested, not_configured, invalid, dev_override] }
        device_source: { type: string, enum: [posture_source, not_configured, dev_override] }
        session_binding: { type: string, enum: [passkey_uv_browser_bound, passkey_uv_unbound, not_passkey, revoked], description: "What the session proves; not device trust" }
    elevation:
      type: object
      additionalProperties: false
      required: [break_glass_live, live, next_expiry_at]
      properties:
        break_glass_live: { type: boolean }
        live:
          type: array
          maxItems: 8
          items: { type: object, additionalProperties: false, required: [id, role, expires_at], properties: { id: { $ref: "#/components/schemas/Uuid" }, role: { $ref: "#/components/schemas/AdminRole" }, expires_at: { type: string, format: date-time } } }
        next_expiry_at: { type: [string, "null"], format: date-time }
    capabilities:
      type: object
      additionalProperties: false
      required: [console.access, flags.read, flags.write, pii.view, kyc.read, kyc.write, kyc_review.read, elevations.admin, ledger.read, ledger.integrity.read, audit_log.read, payout.read, payout.approve, refund.approve, plan_price.update, data_export.create, privacy.read, recon.read, tax.read, brand_review.read, attention.read, metrics.read.counts, metrics.read.money]
      properties: { "console.access": { type: boolean } }   # every listed key is boolean; generator expands the list
    server_time: { type: string, format: date-time }
    session_expires_at: { type: string, format: date-time }
```
Responses: 200 `AdminMe`; 400 unknown query parameter; 401 missing, invalid, expired, revoked or foreign-audience token; 403 `not_admin`; 429; 503 `elevations_unavailable`.

### How admin-web consumes it (builder notes, no change to the API rule that the server decides)
- `api/schemas.ts`: replace the "PROPOSED" `adminMe` with the schema above; keep `z.object` (non-strict) so a later additive field does not break parsing.
- `view-models/posture.ts`: unchanged logic; it already fails closed. Add a branch for `posture.ip_allowlist_source === "not_configured"` to show a distinct banner key ("IP allow-list not configured") so operators know why finance writes are off.
- `server/console.ts`: `me` outcomes become explicit states:
  - 200: as today.
  - 401: redirect to `/login` (as today).
  - 403 `not_admin`: render a full-page "no admin access" state, nav empty, no API calls from pages.
  - offline, 5xx, 503, contract error: `identity: null` with a new `identityState: "unavailable"`; **nav fails closed** to the always-visible items (home, approvals, elevation) plus a retry banner. This changes `navFor(null)` semantics (today `null` shows everything); the change is gated by `release.admin_console.identity` so that before the endpoint ships the current behaviour stays.
  - Replace the shared install id with the **server-minted** install token from the web passkey assertion (section "Session binding"), kept in `__Host-admin-install` and rotated at every login. A client-generated id is not used: a random cookie the browser creates proves nothing the session cookie does not. This change and migration 0092 ship first (dependency T1-a before T1-b), because without them no admin can sign in against the real API.
- `view-models/nav.ts`: keep the role table (VR-AC-05); add an optional `capability` per item where version 1 has one (ledger, finance, audit log, flags, kyc, pii, elevation admin), and prefer it over roles when present.
- `layout.tsx`: top bar shows effective roles, an elevation chip with countdown to `next_expiry_at`, and the posture banner.
- `tooling/e2e/gateway.mjs`: update the `/v1/admin/me` fixture to the new schema; add a real-API e2e (`E2E_REAL_ME=1`) that boots the API, signs in with the test passkey and asserts the fail-closed states (no fake).

### Events
Outbox: none. Analytics: none (admin emits no product analytics). Metric `outlet.admin.me.requests{outcome=allow|deny|unavailable}`.

### Failure handling
Elevations or sessions read: timeout 2 s, no retry inside the request; 503 with Problem+JSON. The console shows the unavailable state; nothing is cached across requests.

### Security and abuse (STRIDE)
- S: forged role hints are impossible (no client input); forged edge header needs the HMAC key, and the API is reachable only through the edge, which strips inbound posture headers; replay is limited to 60 s, bound to an edge-minted request id and single-use. A stolen browser cookie jar yields `session_binding: passkey_uv_browser_bound` but never `device_trusted` (honest naming; no write depends on binding alone).
- T: response is computed per request; no cache layer can be poisoned (`no-store`).
- R: denies audited; allows counted.
- I: returns only the caller's own data; no other user's elevations.
- D: rate limit 120/min; cheap queries (indexed by user id).
- E: capabilities come from the gate predicates, so `me` cannot claim more than the gates allow; a property test enforces equality.
OWASP API: API1/API5 (BFLA) covered by consistency tests; API2 (auth) by the token tests; API8 by `no-store` and strict query.

### Metrics
SLI: `me` p95 < 100 ms; error rate < 0.1 %. Guardrail: share of console sessions in `unavailable` state.

### Tests required
- Negative authorization (HTTP): no token 401; buyer (shopper) token 401 `invalid_credentials`; seller token 401; expired admin token 401; unknown-key or wrong-issuer token 401; revoked session 401; admin-audience actor with no admin grant 403 `not_admin` (the "shopper to admin" case for an admin-audience token); expired standing grant excluded; **expired elevation**: at `expires_at` minus 1 ms the role is in `roles` and `capabilities` and the mirrored route answers 200, at `expires_at` it is absent and the route answers 403; standing super_admin without break-glass: `roles` lacks it and every capability except `console.access` is false for a super_admin-only user; break-glass for a non-standing user is ignored; any query parameter is 400; `X-Admin-Roles` or similar headers have no effect; unsigned, bad-MAC, unknown-kid, stale, wrong-request-id and replayed edge headers give `ip_allowlisted: false`; a MAC of a different length is rejected without calling the compare; Redis down gives `ip_allowlisted: false`; production boot refuses posture keys without the private-ingress attestation; `device_trusted` is false for every Phase A session; `session_binding` is `passkey_uv_unbound` without `X-Admin-Install`, with a wrong token, and with a token of a revoked device; `ADMIN_POSTURE_DEV_TRUST` refused at production boot; 121st request in a minute 429; `Cache-Control: no-store` present.
- Deny audit and metrics (L1, L2): every deny writes exactly one `admin.me` audit row (test per deny case above); an allowed read writes none; each outcome increments its own `outlet.admin.me.requests{outcome}` series.
- Web sign-in (0092 and the assertion branch): `platform: web` with a shopper-only user 403 `web_sign_in_not_allowed`; a client-supplied `install_id` for `web` is ignored; `auth_sessions.uv` true only on the passkey path; a second login revokes the previous web device; refresh with a mismatched `X-Admin-Install` 401 and family revoked; `install_token` never appears in logs (log-capture test).
- **HTTP-route capability equality** (H1): for random actors (grants, expiries, elevations, amr, now), for each capability, `capabilities[k]` equals "the mirrored route answers non-403" on the booted app (`payout.approve` exercises `POST /v1/admin/finance/payouts/{id}/approve`, so the in-handler `requireFinance` is covered). Plus the pure property: `assurance` agrees with policy `assurance`; `roles` is a subset of `standing_roles` union live elevation roles.
- Mutation targets (Stryker, >= 80 %): `computeAccess`, the capability predicates, posture evaluation (server) and `evaluatePosture` (web), edge-header verification, install-token check.
- admin-web unit: each `me` outcome renders its state; nav fails closed when the flag is allowed; posture banner keys.

### Rollout
Flag `release.admin_console.identity` (default blocked: the route answers 404 and the console keeps today's behaviour). Allow per environment after migration 0092, the web assertion branch and the install-token change are deployed. CR checkpoint (auth/ACL, including the attestation-free web sign-in path) before allowing in staging. Writes that the console gates on `device_trusted` stay disabled until VR-AC-04 names a posture source; that is the intended state.

---

## 2. Track 2: `GET /v1/seller/me` and store-scoped `me`

### Flow
1. seller-web `pageCtx()` reads the active store id (existing `/v1/seller/store` result, or the `sc_store` cookie when the user holds several memberships), then calls `GET /v1/seller/stores/{storeId}/me` once per request.
2. API, in this order (M8): (a) validates the path id shape (malformed is 404); (b) **authorises first from the token**: if the actor holds no brand grant for that store id, answer 404 immediately, without a database read; (c) only for a held grant, looks up the store row (`id, status`) with the existing store resolver; a held grant on a missing row is 404 with the same body; (d) computes the permission set by evaluating the policy engine's `decide()` for every brand rule's (resource, action) against this actor, the presented token scopes and **the real store state** (`resource.state` mapped from `stores.status`: `ACTIVE` to `active`, `PAUSED` to `paused`, `SUSPENDED` to `suspended`, `DRAFT` to `draft`), never a constant `active`. Because foreign and unknown ids both stop at step (b), they share one code path, one body and one timing class.
3. seller-web sets `ctx.role` and `ctx.permissions`; `Shell` calls `navFor(permissions)`.

### Rules
- Role and permissions come only from the verified token grants and the policy rules. **No new grant is created**: permissions are the existing `brand(...)` rules in `packages/policy/src/rules.ts` evaluated, nothing more.
- The existing `GET /v1/seller/me` stays and gains two additive fields per membership (`store_status`, `permissions`) plus `server_time`. Old clients keep parsing.
- Permission keys (version 1) are `"<resource>.<action>"` for each brand rule action: `store_product.{read,create,update,delete}`, `store_inventory.{read,create,update}`, `store_order.{read,update}`, `store_return.{read,update}`, `store_payout.read`, `store_settings.{read,update}`, `store_staff.{read,create,update,delete}`. Two derived keys mirror the seller-analytics authorization exactly as specified there: `analytics.read` = `store_order.read`, `analytics.export` = `store_settings.read`. A dedicated `store_analytics` resource is an owner decision (ADR-0049); it is not introduced.
- Token scopes count: a `seller:enrol` token yields every permission false (it cannot reach seller routes anyway).
- Suspended or paused store: `store_status` reflects it; the permission set is whatever `decide()` returns for that state (today every `*.create|update|delete` is false for `suspended`, the outcome the resolver gives writes); reads follow the policy. The route never overrides `decide()`.
- `GET /v1/seller/me` (all memberships) also passes each store's real state; it batch-loads `status` for the held store ids only (one indexed query, at most 30 ids).
- Role vocabulary: the wire uses the policy vocabulary (`warehouse`, `support`). seller-web maps `warehouse` to the label "Fulfilment / التجهيز" in i18n. The web `teamRole` enum and OpenAPI `TeamMember.role` move to the policy vocabulary by expand and contract (accept both for one release, emit policy names). This is naming only, not a permission change; it is listed in ADR-0050 with the `/v1/seller/team` path fix.

### Edge cases
- Seller with several stores and no `sc_store` cookie: pick the first membership by store id order (deterministic) and show the store switcher.
- Membership removed during a session: the next request's token refresh drops the grant; store-scoped `me` answers 404; seller-web clears `sc_store` and redirects to the store chooser.
- `me` unavailable (5xx, offline): `role: null`, `permissions: null`; nav fails closed to `/dashboard` and `/settings` hidden, with a retry banner. Routes still decide (403/404).

### Data
No new table. PII P1 (own memberships).

### API
- `GET /v1/seller/me` (existing; additive fields) · audience `seller_api` · scope `seller:read` · 120/60 s per user · P1.
- `GET /v1/seller/stores/{storeId}/me` (new) · same audience, scope and limit · P1 · 404 for foreign, missing or malformed store.

```yaml
SellerPermissions:
  type: object
  additionalProperties: false
  required: [store_product.read, store_product.create, store_product.update, store_product.delete, store_inventory.read, store_inventory.create, store_inventory.update, store_order.read, store_order.update, store_return.read, store_return.update, store_payout.read, store_settings.read, store_settings.update, store_staff.read, store_staff.create, store_staff.update, store_staff.delete, analytics.read, analytics.export]
  properties: { "store_product.read": { type: boolean } }   # every listed key is boolean
SellerMembership:
  type: object
  additionalProperties: false
  required: [store_id, role, store_status, permissions]
  properties:
    store_id: { $ref: "#/components/schemas/Uuid" }
    role: { type: string, enum: [owner, manager, catalog, warehouse, finance, support] }
    store_status: { type: string, enum: [draft, active, paused, suspended] }   # lower-case of stores.status (0013_stores.sql:26-27)
    permissions: { $ref: "#/components/schemas/SellerPermissions" }
SellerMe:            # existing schema, extended additively
  required: [user_id, memberships]
  properties:
    user_id: { $ref: "#/components/schemas/Uuid" }
    memberships: { type: array, maxItems: 30, items: { $ref: "#/components/schemas/SellerMembership" } }
    server_time: { type: string, format: date-time }
SellerStoreMe:
  type: object
  additionalProperties: false
  required: [user_id, membership, server_time]
  properties:
    user_id: { $ref: "#/components/schemas/Uuid" }
    membership: { $ref: "#/components/schemas/SellerMembership" }
    server_time: { type: string, format: date-time }
```
The `store_status` enum was checked against `stores.status` (finding F9) and corrected; the earlier draft values (`deactivated`, `onboarding`) do not exist in the schema.

### How seller-web consumes it
- `page-context.ts`: call store-scoped `me`; put `role` and `permissions` on `Ctx` (type `SellerRole` from the policy vocabulary, not `TeamRole`).
- `view-models/nav.ts`: key every item on a required permission (dashboard `analytics.read`, catalog `store_product.read`, orders `store_order.read`, returns `store_return.read`, finance `store_payout.read`, marketing/ads/resale/team/settings `store_settings.read`, drops/insights/media/forecasts/channels/price-trust `store_product.read`, hub `store_order.read`). These mirror the routes' existing gates; where a page's API gate is unknown the builder reads the controller and records it in the nav table comment. `navFor(null)` fails closed (behind the flag).
- `components/Shell.tsx`: pass permissions; add the store switcher when `memberships.length > 1`.
- `loaders.ts`: `availableActions(o.status, c.role)` reads permissions (`store_order.update`) instead of the web role.

### Events, failure handling
No events. Store resolver timeout 2 s; 503 on failure (never a partial membership).

### Security and abuse (STRIDE)
- S: grants come from the signed token; store id from the path is only a lookup key.
- T: none (read).
- R: denies audited via the guard's existing audit.
- I: foreign store 404 with identical body and timing class as missing, because the authorisation check from the token runs before any store lookup (step b).
- D: 120/min.
- E: permissions are `decide()` outcomes; a property test proves no permission is true that the matching route would refuse.

### Tests required
- Negative authorization: buyer token 401; admin token 401; seller A on store B 404 (body byte-equal to the missing-store body); malformed uuid 404; removed membership 404; suspended store: `store_status: suspended`, permissions equal `decide()` with state `suspended` (all writes false) and a write route answers 403; paused store: permissions equal `decide()` with state `paused`.
- No lookup before authorisation: with a spy on the store repository, a foreign id and an unknown id cause **zero** store reads; a held id causes exactly one. Timing class: over 200 requests each, the median latency of foreign and unknown ids differs by less than the run-to-run noise bound used by the existing resolver test (both skip the database, so the test is a regression guard, not a statistics exercise).
- Role matrix: for each of the six brand roles, `permissions` equals a committed snapshot and equals `decide()` for each rule; nav for each role equals a committed snapshot.
- Property: random actors and stores, `permissions[k] === routeGate(k)`.
- Mutation target: the permission evaluator wrapper in `packages/policy`.

### Rollout
Flag `release.seller_center.role_nav` (default blocked: seller-web keeps `navFor(null)` showing all links). The server fields are additive and always present.

---

## 3. Track 3: `GET /v1/admin/ledger/integrity`

### Storage decision (ADR-0046)
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| A. New append-only `ledger_integrity_runs` table, one row per run, plus one `audit_log` entry per run | low (one table, one adapter) | exact; history kept; queryable | ~50 rows/day | trivial |
| B. Reuse `audit_log` (chain `ledger-integrity:YYYY-MM`, report in `diff_redacted`) | low | tamper-evident, but the report is a jsonb blob in an actor-action log; P2 class and retention of `audit_log` apply | none | fine |
| C. In-process scheduler state or a Prometheus gauge only | lowest | lost on restart, differs per instance, no history | none | n/a |

Choice: **A, plus a per-run `audit_log` row** that stores the run id and the report's SHA-256. The table gives a typed, indexable read model for the route and history; the audit row makes a later edit of the table detectable against the hash chain. C is rejected because a restart would show "never run" for a ledger that failed an hour ago.

### Flow
1. Scheduler runs `ledger.integrity.nightly` (02:30 Cairo) and `ledger.integrity.intraday` (every 30 min, event mode only). The registry token changes from `INTEGRITY_JOB` to `INTEGRITY_RECORDER`.
2. `RecordIntegrityRun.run(kind)`: inserts a `started` row, calls the unchanged `IntegrityJob.run()`, then, **in one database transaction** (H4), inserts the completed row (or an `error` or `timeout` row), its drift sample rows, and the audit entry (`ledger.integrity.run`, chain `ledger-integrity:YYYY-MM`, `target_type = 'ledger_integrity_run'`, `target_id = run id`, `diff_redacted = {run_id, ok, report_sha256}`). The audit sink is called with the same transaction (the Kysely audit adapter accepts a `DbTx`). If the audit insert fails, the transaction rolls back: **no completed row exists**, the gauges keep reporting the previous completed run, and the dead-man alert fires. A completed run without audit evidence therefore cannot be produced by the application.
3. Alerting: the API process exports the gauges **from the table** on every metric collection (below); Prometheus rules page on failure, staleness and absence; the in-app attention queue (track 7) reads the latest row.
4. `GET /v1/admin/ledger/integrity` returns the latest completed run, the latest attempt and the freshness state; each run carries `audit_evidence: present | missing`, computed by looking up the audit row by `(target_type, target_id)` (index `audit_log_target_idx`, `0005:35`). `missing` can only result from tampering or a manual insert and is treated as `failed` for `state` and for alerting. `GET /v1/admin/ledger/integrity/runs` pages history.

### Rules
- `IntegrityJob` stays pure and unchanged. The recorder owns persistence and metrics; the report is mapped to the row with no recomputation.
- Freshness: expected cadence is nightly in batch mode and 30 min in event mode (read from the worker mode config). **Stale** when the latest *completed* run started more than 26 h ago (batch) or 90 min ago (event mode). `state` precedence: `failed` (latest completed `ok=false`, or its `audit_evidence = missing`) over `stale` over `ok`; `never_run` when no completed run exists; `error_only` when attempts exist but none completed.
- **Tamper evidence has limits, stated plainly.** `forbid_mutation` triggers and the audit hash chain are tamper-evident only against roles that cannot disable triggers or rewrite the chain; a database superuser (or the migration owner) can do both. The independent evidence is the **signed snapshot** (KMS signature over the journal chain head and the audit chain checkpoints, exported off the database), which is **not built** (ADR-0046, waits for KMS under ADR-0002 and ADR-0032). It is recorded as a **launch blocker** in section 8 and must be on `docs/plan/release-checklist.md` before go-live (that file is outside this amendment's edit scope; the release-checklist owner adds it).
- A failed attempt never hides the last completed result: both are returned.
- Gate: identical to the existing ledger gate (unexpired **standing** `finance` grant plus passkey, audit every decision, fail closed with 503 `audit_unavailable`). Security role access is an owner decision (ADR-0049, Proposed): default **finance only**. The brief asked for "finance and security"; the benchmark (section 9) lists "Security reading ledger tiles" as an owner decision and the policy has no security ledger grant, so this spec does not add it. Security is paged by Prometheus on a failure (out of band, no data in the page beyond "integrity failed, run id").
- Store-credit drift sample: at most 50 rows, ordered by absolute difference then user id; `sample_truncated` when more exist. User ids are internal identifiers that finance already sees in `/v1/admin/ledger/balances`. The sample is stored in a **child table** (`ledger_integrity_drift_samples`) so it can follow its own retention while the run row stays immutable (see Data); after the sample is purged the run reports `sample_available: false` and `report_sha256` can no longer be recomputed from stored rows (documented; the audit row still carries the hash).
- Amounts in the response are strings of integer piastres; chain `length` and `seq` are strings (bigint).

### Edge cases
- Two instances run the same job concurrently: the existing leader lock prevents it; if both run, two rows are written (append-only, harmless).
- Job timeout (30 min nightly): `timeout` row; the gauge for last success is not updated, so the dead-man alert fires.
- Chain failure: `chain.failure = {seq, entry_id, reason}`; the job stops walking at the first failure (existing behaviour).
- Empty ledger: chain length 0, trial balance ok, state `ok`.
- Clock skew between worker and API: freshness uses the row's `started_at` (database `now()` at insert), never the worker clock.

### Data (migration `0089_ledger_integrity_runs.sql`, expand only)
```sql
CREATE TABLE ledger_integrity_runs (
  id               uuid PRIMARY KEY,                       -- uuidv7 from the application
  run_kind         text NOT NULL CHECK (run_kind IN ('nightly', 'intraday', 'manual')),
  outcome          text NOT NULL CHECK (outcome IN ('started', 'completed', 'error', 'timeout')),
  attempt_id       uuid NOT NULL,                          -- groups the started row with its final row
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  ok               boolean,                                -- NULL unless outcome = completed
  trial_ok         boolean,
  trial_offenders  jsonb,                                  -- [{currency, total_minor:string}]
  chain_ok         boolean,
  chain_length     bigint,
  chain_head_hash  text CHECK (chain_head_hash IS NULL OR chain_head_hash ~ '^[0-9a-f]{64}$'),
  chain_failure    jsonb,                                  -- {seq:string, entry_id, reason}
  drift_count      integer CHECK (drift_count IS NULL OR drift_count >= 0),
  negative_count   integer CHECK (negative_count IS NULL OR negative_count >= 0),
  sample_truncated boolean,
  error_code       text CHECK (error_code IS NULL OR char_length(error_code) <= 64),
  report_sha256    text CHECK (report_sha256 IS NULL OR report_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT lir_completed_chk CHECK (outcome <> 'completed' OR (ok IS NOT NULL AND trial_ok IS NOT NULL AND chain_ok IS NOT NULL AND report_sha256 IS NOT NULL))
);
CREATE INDEX lir_completed_idx ON ledger_integrity_runs (started_at DESC) WHERE outcome = 'completed';
CREATE INDEX lir_started_idx   ON ledger_integrity_runs (started_at DESC);
CREATE TRIGGER lir_immutable_trg BEFORE UPDATE OR DELETE ON ledger_integrity_runs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE ledger_integrity_drift_samples (
  run_id              uuid NOT NULL REFERENCES ledger_integrity_runs (id),
  ord                 smallint NOT NULL CHECK (ord BETWEEN 1 AND 50),
  user_id             uuid NOT NULL,                       -- P2 in this context (links a person to a balance anomaly)
  sub                 text NOT NULL CHECK (char_length(sub) <= 32),
  projected_minor     bigint NOT NULL,
  from_postings_minor bigint NOT NULL,
  difference_minor    bigint NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, ord)
);
CREATE INDEX lids_created_idx ON ledger_integrity_drift_samples (created_at);
CREATE TRIGGER lids_no_update_trg BEFORE UPDATE ON ledger_integrity_drift_samples FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
-- RLS (concrete roles, finding F1; 'admin' is not a valid app.role):
--   ledger_integrity_runs, ledger_integrity_drift_samples: SELECT USING (app_role() IN ('finance','super_admin','system'))
--   (mirrors ledger_entry_chain, 0031:34-35); INSERT WITH CHECK (app_role() = 'system').
--   drift samples: DELETE for 'system' only (retention purge); no UPDATE for anyone.
--   The route reads after the HTTP gate under the finance session; the recorder writes under asSystemRole.
```
PII: run rows P1; drift samples **P2** (a user id tied to a store-credit anomaly). `data_inventory.yaml` entries required for both tables (purpose `finance_integrity`).
Retention (owner decision, ADR-0046 Proposed on this point, VR-DASH-08): run rows (no user ids) 7 years like financial evidence. **Safe default for drift samples: 25 months**, purged by the retention job on `created_at` (target `ledger.integrity_samples`), and the samples are pseudonymised by the erasure flow like other financial records; keeping user ids for 7 years needs the owner's and counsel's confirmation.

### API
- `GET /v1/admin/ledger/integrity` · `admin_api` · `admin:ledger.read` · 60/60 s per user · P1.
- `GET /v1/admin/ledger/integrity/runs?cursor&limit` (limit 1-50, default 20, keyset on `(started_at, id)`) · same gate.

```yaml
LedgerIntegrityRun:
  type: object
  additionalProperties: false
  required: [id, run_kind, started_at, finished_at, ok, trial_balance, chain, store_credit, report_sha256, audit_evidence]
  properties:
    id: { $ref: "#/components/schemas/Uuid" }
    audit_evidence: { type: string, enum: [present, missing] }   # missing = tamper signal; state is failed
    run_kind: { type: string, enum: [nightly, intraday, manual] }
    started_at: { type: string, format: date-time }
    finished_at: { type: string, format: date-time }
    ok: { type: boolean }
    trial_balance:
      type: object
      required: [ok, offenders]
      properties:
        ok: { type: boolean }
        offenders: { type: array, maxItems: 8, items: { type: object, required: [currency, total_minor], properties: { currency: { type: string, enum: [EGP] }, total_minor: { $ref: "#/components/schemas/SignedMinorString" } } } }
    chain:
      type: object
      required: [ok, length, head_hash, failure]
      properties:
        ok: { type: boolean }
        length: { type: string, pattern: "^[0-9]{1,19}$" }
        head_hash: { type: [string, "null"], pattern: "^[0-9a-f]{64}$" }
        failure: { oneOf: [ { type: "null" }, { type: object, required: [seq, entry_id, reason], properties: { seq: { type: string }, entry_id: { $ref: "#/components/schemas/Uuid" }, reason: { type: string, maxLength: 64 } } } ] }
    store_credit:
      type: object
      required: [drift_count, negative_count, sample, sample_truncated, sample_available]
      properties:
        sample_available: { type: boolean }   # false once the drift sample passed its retention
        drift_count: { type: integer, minimum: 0 }
        negative_count: { type: integer, minimum: 0 }
        sample: { type: array, maxItems: 50, items: { type: object, required: [user_id, sub, projected_minor, from_postings_minor, difference_minor], properties: { user_id: { $ref: "#/components/schemas/Uuid" }, sub: { type: string }, projected_minor: { $ref: "#/components/schemas/SignedMinorString" }, from_postings_minor: { $ref: "#/components/schemas/SignedMinorString" }, difference_minor: { $ref: "#/components/schemas/SignedMinorString" } } } }
        sample_truncated: { type: boolean }
    report_sha256: { type: string, pattern: "^[0-9a-f]{64}$" }
LedgerIntegrityStatus:
  type: object
  additionalProperties: false
  required: [as_of, state, stale, stale_after, expected_cadence, latest, latest_attempt]
  properties:
    as_of: { type: string, format: date-time }
    state: { type: string, enum: [ok, failed, stale, never_run, error_only] }
    stale: { type: boolean }
    stale_after: { type: [string, "null"], format: date-time }
    expected_cadence: { type: string, enum: [nightly_0230_cairo, every_30_min] }
    latest: { oneOf: [ { type: "null" }, { $ref: "#/components/schemas/LedgerIntegrityRun" } ] }
    latest_attempt: { oneOf: [ { type: "null" }, { type: object, required: [attempt_id, started_at, outcome, error_code], properties: { attempt_id: { $ref: "#/components/schemas/Uuid" }, started_at: { type: string, format: date-time }, outcome: { type: string, enum: [started, completed, error, timeout] }, error_code: { type: [string, "null"] } } } ] }
```
`SignedMinorString` is a new component: `^-?[0-9]{1,19}$` (the trial balance offender and drift can be negative).

### Events and metrics
- Gauges (H5), **exported from the table, not from the job**: the API process registers observable gauges whose callback reads the latest completed row (one indexed query on `lir_completed_idx`, result cached 30 s) on every collection (OTLP push every 15 s, finding F7). So a worker restart, a dead worker or a stuck scheduler cannot freeze or hide the value: `outlet.ledger.integrity.ok` (1 or 0; reported 0 when the latest completed row has `audit_evidence = missing`) and `outlet.ledger.integrity.last_completed_age_seconds` (now minus `started_at` of the latest completed row). With no completed row, `ok` is not reported and the age gauge reports seconds since the table's first `started` row (or is not reported if the table is empty), so the absence rule fires. Counter `outlet.ledger.integrity.runs{outcome}` (from the recorder).
- Prometheus rules (new file `infra/observability/prometheus/rules/ledger-integrity.rules.yaml`, promtool test `prometheus/tests/ledger-integrity.test.yaml`):
  - `outlet_ledger_integrity_ok == 0` for 1 m: page Finance and Security.
  - age > 26 h (batch) or > 90 min (event mode): page Finance.
  - **`absent_over_time(outlet_ledger_integrity_ok[30m])`: page Finance and Platform** (no completed run ever, API not exporting, or the collector path broken). Same pattern as `slo-checkout-success.rules.yaml:100`.
  - `increase(outlet_ledger_integrity_runs{outcome="error"}[1h]) > 0`: ticket Platform.
  - promtool cases: fires at each threshold and not one evaluation before; absence fires at 30 m and not at 29 m; recovery clears.
- **Alert payloads carry no hash-chain details** (L3): labels and annotations hold only `run_id`, `state` and the runbook link; never `head_hash`, `chain_failure.seq`, `entry_id`, drift rows or amounts (rule-file lint test greps annotations for those field names).
- **CI gap (F7):** promtool runs only in `tooling/infra/verify.sh`; track 3 adds a CI job that runs `promtool check rules` and `promtool test rules` on `infra/observability/prometheus/**`. Alert **delivery** (Alertmanager or an on-call vendor, routing to Finance, Security, Platform) does not exist in the repo and is a **launch blocker** (section 8); until then the rules are verified but page no one.
- No outbox event (the result is not a domain state change).

### Failure handling
Recorder insert fails before the job: the job does not run (fail closed, scheduler counts a failure). The final transaction (run row, samples, audit row) fails: retry 3 times with backoff and jitter; on final failure log `ledger_integrity_record_failed` with the attempt id only (no amounts, no hashes) and increment `outlet.ledger.integrity.audit_failed` when the cause was the audit insert. No completed row is written, so the table-backed gauges age and the staleness and absence alerts fire. There is no state in which a completed run exists without its audit row, except by direct database tampering, which `audit_evidence: missing` exposes.

### Security and abuse (STRIDE)
- S: finance passkey gate. T: rows immutable for non-superusers, report hash in the hash-chained audit log written in the same transaction, `audit_evidence` checked on read; superuser tampering is only detectable once the signed snapshot exists (launch blocker). R: every read audited (allow and deny) through the existing gate. I: run rows P1, drift samples P2 with their own retention; no counterparty names; sample capped; alert payloads carry no chain details. D: 60/min; reads are index-only. E: no write route; manual runs are not exposed over HTTP in Phase A.

### Tests required
- Negative authorization: shopper 401, seller 401, ops/security/marketing/dpo/support/trust_safety 403 with a deny audit row, finance without passkey 403 `passkey_required`, expired finance grant 403, standing super_admin 403, finance by elevation only 403 (matches the existing ledger gate, which reads standing grants; see open decisions), audit sink down 503 `audit_unavailable` with no report bytes in the body.
- State tests with a fake clock: never_run, ok, failed, stale at exactly 26 h and 26 h + 1 ms, error_only, failed-then-error keeps `latest` failed.
- Stale-result and absence alerts: promtool tests fire at each threshold and not one evaluation before; `absent_over_time` fires at 30 m; CI runs them.
- Gauges from the table: with the worker stopped, the age gauge keeps growing on each collection (test with a fake clock and the API process only); with a completed row whose audit row is deleted by a superuser in PGlite, `ok` reports 0 and `state` is `failed`.
- Same-transaction audit (H4): inject an audit insert failure; assert no completed row and no sample rows exist, the gauges still report the previous run, and `audit_failed` incremented.
- Recorder: report to row mapping round-trip; `report_sha256` stable for the same report (canonical JSON); immutability trigger rejects UPDATE and DELETE on runs and UPDATE on samples (PGlite); RLS: an `ops` session reads zero rows, a `finance` session reads them, a non-system session cannot insert.
- Alert lint (L3): no rule annotation or label references `head_hash`, `seq`, `entry_id`, `drift` or `_minor`.
- Mutation targets: the state and staleness function, the report-to-row mapper.

### Rollout
Flag `release.admin.ledger_integrity` gates the two routes (404 when blocked). Recording is always on once deployed. CR checkpoint (ledger read path) before allowing.

---

## 4. Track 4: time-series contract (seller analytics and admin metrics)

### Contract
```yaml
MetricSeries:
  type: object
  additionalProperties: false
  required: [id, version, window, grain, unit, currency, additive, series, totals, as_of, basis, suppressed, notes]
  properties:
    id: { type: string, pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$" }   # registry key, e.g. seller.sales.gmv
    version: { type: integer, enum: [1] }
    window:
      type: object
      required: [from, to, tz, requested_from, requested_to]
      properties:
        from: { type: string, format: date-time }        # snapped outward to a bucket boundary in tz
        to: { type: string, format: date-time }          # exclusive; clamped to the end of the current bucket
        tz: { type: string, enum: [Africa/Cairo] }
        requested_from: { type: string, format: date-time }
        requested_to: { type: string, format: date-time }
        preset: { type: [string, "null"], pattern: "^(month:[0-9]{4}-[0-9]{2}|last_full_months:(1|3|6|12)|current_month)$" }   # set for shopper-gated metrics only (fixed grid)
    grain: { type: string, enum: [hour, day, week, month] }
    unit: { type: string, enum: [piastres, count, bps, distinct_shoppers] }
    currency: { type: [string, "null"], enum: [EGP, null] }
    additive: { type: boolean }                           # false for distinct counts and rates: never sum points
    series:
      type: array
      minItems: 1
      maxItems: 2
      items:
        type: object
        required: [key, from, to, points]
        properties:
          key: { type: string, enum: [current, previous] }
          from: { type: string, format: date-time }
          to: { type: string, format: date-time }
          points:
            type: array
            maxItems: 400
            items:
              type: object
              additionalProperties: false
              required: [t, label, offset_min, hours, v, state]
              properties:
                t: { type: string, format: date-time }    # bucket start, UTC instant
                label: { type: string }                   # local: 2026-10-29 | 2026-10-29T23 | 2026-W44 | 2026-10
                offset_min: { type: integer, enum: [120, 180] }   # UTC offset at bucket start
                fold: { type: integer, enum: [0, 1] }      # hour grain only: 1 = the repeated local hour
                hours: { type: integer, minimum: 1, maximum: 745 }  # real hours in the bucket (23, 24, 25 for days)
                v: { oneOf: [ { type: "null" }, { type: string, pattern: "^-?[0-9]{1,19}$" }, { type: integer } ] }  # string when unit = piastres
                state: { type: string, enum: [ok, partial, suppressed, not_measured, no_bucket, held] }   # held = anomaly guard (track 5), v null
    totals:
      type: object
      required: [current, previous, delta, delta_bps]
      properties:
        current: { oneOf: [ { type: "null" }, { type: string }, { type: integer } ] }
        previous: { oneOf: [ { type: "null" }, { type: string }, { type: integer } ] }
        delta: { oneOf: [ { type: "null" }, { type: string }, { type: integer } ] }
        delta_bps: { type: [integer, "null"] }           # floor((current-previous)*10000/previous); null if previous is 0 or null
    as_of: { type: [string, "null"], format: date-time }  # data complete through this instant; null = never ingested
    basis: { type: string, enum: [exact_facts, rollup, rollup_reconciled, ledger, operational, batch] }
    suppressed:
      type: object
      required: [k, primary, complementary, memo, whole_series]
      properties:
        k: { type: integer, enum: [50] }
        primary: { type: integer, minimum: 0 }
        complementary: { type: integer, minimum: 0 }
        memo: { type: integer, minimum: 0 }          # cells and margins hidden because an earlier release hid them (monotone)
        whole_series: { type: boolean }
    notes: { type: array, maxItems: 5, items: { type: string, enum: [consent_sampled, includes_late_data, launch_period, tz_rules_unverified, anomaly] } }
MetricBreakdownSeries:       # only for shopper-gated dimensions; flag release.seller_analytics.shopper_series (DPO)
  allOf: [ { $ref: "#/components/schemas/MetricSeries" } ]
  properties:
    dimension: { type: string, enum: [source, governorate] }
    rows: { type: array, maxItems: 11, items: { type: object, required: [key, points], properties: { key: { type: string }, points: { $ref: "#/components/schemas/MetricSeries/properties/series/items/properties/points" } } } }   # month grain only; no row_total (ADR-0052: no internal margins)
    external_total_metric: { type: string }   # the ungated metric shown as the column total (e.g. seller.sales.orders), labelled as ungated
```
`null` with `state: not_measured` renders "Not measured"; `suppressed` renders "Insufficient data (fewer than 50 shoppers)"; `partial` is the in-progress bucket; `no_bucket` is a previous-period slot that does not exist (DST, see below); `held` renders "Unusual activity, under review" (anomaly guard, track 5) and is never a zero. Points are always ordered oldest first; the contract is direction-neutral and the chart decides axis direction (ADR-0047).

### Cairo buckets (ADR-0047, display decision Proposed; bucketing default Africa/Cairo)
- **Hour bucket** = one real UTC hour `[t, t+1h)`. Egypt's offsets are whole hours (UTC+2 in winter, UTC+3 in summer), so local hours and UTC hours coincide. The label is the local hour; `offset_min` is the offset at `t`; `fold = 1` marks the second occurrence of a repeated local hour.
- **Day bucket** = all hour buckets whose local date is D: from the first instant with local date D to the first instant with local date D+1. Computed as `cairoLocalToUtc(D, 00:00)` to `cairoLocalToUtc(D+1, 00:00)`, which resolves the skipped midnight forward.
- Egypt DST since 2023 (benchmark section 6.1; tzdata rule `Egypt 2023 max`): starts the **last Friday of April at 00:00**, clocks to 01:00; ends the **last Thursday of October at 24:00**, clocks back to 23:00. Consequences (VR-DASH-01 verifies the rule stays in force):
  - Spring day (2026-04-24, 2027-04-30): **23 hours**, local 00:00-00:59 does not exist, the day starts at local 01:00 (22:00 UTC of the previous calendar day).
  - Autumn day (2026-10-29, 2027-10-28): **25 hours**, local 23:00-23:59 occurs twice (`fold 0` at UTC+3, `fold 1` at UTC+2). Note 2026-10-29 is 13 days after this spec.
  - Every instant maps to exactly one hour bucket and one day bucket; a year has 8,760 or 8,784 hour buckets regardless of DST.
- **Week** = 7 local days starting **Saturday** (ADR-0047 Proposed default; Egypt's weekend is Friday and Saturday, `docs/specs/admin-essentials.md`). **Month** = local calendar month.
- Bucketing uses the Node `Intl` time-zone data through `apps/api/src/workers/cairo.ts` (moved to `packages/domain/src/time/cairo.ts` so domain code can use it without importing workers). Postgres never converts time zones for analytics; rollup rows store the derived `cairo_date`, `cairo_hour` and `utc_offset_min` at write time.
- CI pins the expected fixtures above; a test fails if the runtime's tz data disagrees (guard against an outdated ICU).

### Windows, limits and previous-period alignment
- `from` and `to` are required ISO instants; the server snaps outward to whole buckets of the requested grain in Africa/Cairo, then clamps `to` to the end of the current bucket. `from >= to` is 400 `invalid_window`.
- Maximum points per series: hour 7 days (at most 169 points), day 366 days, week 104, month 36. Larger is 400 `window_too_large`. No pagination: the cap bounds the payload (~30 KB worst case with both series).
- **Shopper-gated metrics use a fixed calendar grid, never arbitrary `from`/`to`** (B2). Shopper-gated means: unit `distinct_shoppers` (`seller.traffic.unique_visitors`), rates over shoppers (`seller.sales.repeat_rate_bps`) and every breakdown by `source` or `governorate`. Their requests carry `preset` instead of `from`/`to` (both given, or `from`/`to` alone, is 400 `window_not_on_grid`):
  - `month:YYYY-MM` (one complete Cairo month), `last_full_months:N` with N in {1, 3, 6, 12} (complete months ending before the current one), `current_month` (complete days of the current month, **no margins**).
  - Grains (ADR-0052): **breakdowns (`source`, `governorate`) are released at `month` only**; any other grain is 400 `grain_not_allowed`. Non-additive gated series (`unique_visitors`, `repeat_rate_bps`) allow `day` and `month`. `hour` and `week` are always 400 for gated metrics (a Saturday week straddles months).
  - **Settle horizon S** (default 48 h, admin-editable with audit, minimum 24 h): a gated bucket is released only when `now >= bucket_end + S`, and its cells read only facts with `ingested_at <= bucket_end + S` (new column `seller_analytics_facts.ingested_at timestamptz NOT NULL DEFAULT now()`, migration 0090). `current_month` therefore holds only settled complete days, and only for non-additive series. Facts that arrive later feed the ungated rollups only.
  - Breakdowns publish **no internal margins**: no row totals, no multi-month totals and no grand total computed from gated cells. The only sums over a breakdown column are the **external margins**, meaning the ungated metric that equals the column sum. That metric is released at every grain, so the release treats it as always published (see the k-anonymity section).
- Ungated metrics keep arbitrary `from`/`to` snapped outward to Cairo buckets, as above.
- `compare=previous_period` (default) or `none`. The previous window has the **same number of buckets** immediately before `window.from`, aligned **by bucket index** (day i of current with day i of previous), never by duration, so a 23-hour day aligns with a 24-hour day. For gated metrics the previous window is the same preset shifted back by its own length in whole months (`month:2026-09` compares with `month:2026-08`; days aligned by index, a missing day 31 is `no_bucket`), and it is released **through the same release ledger** as any other request: a previous-period cell hidden once stays hidden, and one released once is served with its pinned value. For hour grain, alignment is by (day index, local hour, fold); a slot with no counterpart (the skipped spring hour, or `fold = 1` against a normal day) has `v: null, state: no_bucket`. `previous_year` is out of scope for Phase A.
- Totals: for additive metrics `totals.current` is the sum of released `ok` and `partial` points; for non-additive metrics it is computed exactly over the window (distinct shoppers over the whole window, rate over window numerators and denominators), never a sum of points.
- Derived ratios (AOV, conversion) are computed per bucket from integer numerators and denominators: AOV in piastres with banker's rounding at one point (existing `sales` rule); bps with `floor`. Division by zero gives `null, state: ok` with the tile showing "No orders".

### One window function for every shopper-gated read (B1)
Today every legacy route snaps to **UTC** days (`snapToDays`, finding F11) while the series contract buckets in **Africa/Cairo**. Two gated reads with different day boundaries over the same facts can be subtracted to isolate the two or three boundary hours. Rule:
- `gatedWindow(request) -> CairoGridWindow` in `packages/domain/src/time/cairo.ts` is the **only** function that turns a request into a window for a shopper-gated read. It is used by `releaseShopperTable` and therefore by every legacy gated field (`traffic.by_source`, `geography`, `sales.repeat_rate`, `traffic.unique_visitors`, `search_terms`) and every gated series, **in the same release**. `snapToDays` is deleted from the gated path in that release (it may remain for ungated legacy fields until they switch too, see below). The grid is the one chosen by ADR-0047 (Cairo days and months).
- Because the switch changes a seller-facing privacy control (the window boundaries of released gated numbers) together with the fold rule below, it is **one DPO decision** (VR-DASH-02 and VR-DASH-05). Until it is taken, the shopper-gated series (`repeat_rate_bps`, `unique_visitors`, all breakdowns) sit behind the separate DPO-controlled flag **`release.seller_analytics.shopper_series`** (owner: DPO; default blocked), not under `release.seller_analytics.series`, and the legacy gated fields keep today's behaviour (UTC days, fold rule) **except** the M5 change to `unique_visitors` below, which only reduces disclosure.
- Allowing `release.seller_analytics.shopper_series` is a single deploy-time switch that moves, together: every legacy gated field to `gatedWindow` (Cairo grid, presets) and to `releaseShopperTable` (complementary suppression with the memo), and enables the gated series. There is no state where some gated reads are UTC and others Cairo. Legacy gated fields then accept `preset` and map a legacy `from`/`to` request to the smallest enclosing preset (`month:` or `last_full_months:`), returning the preset in `meta` so the seller sees what was released.
- Ungated fields and ungated series (GMV, orders, units, views, impressions, funnel counts, returns) are not k-gated and use Cairo buckets under `release.seller_analytics.series`. A legacy response that mixes gated and ungated fields keeps one window per response: until the DPO flag is allowed, those legacy routes stay entirely on UTC days (ADR-0047 decision 3 is narrowed accordingly), and the store-scoped summary tiles come from the Cairo series.

### k-anonymity: one repository function, monotone suppression (B2)
Applies only to shopper-gated metrics. Scalar additive series (GMV, orders, units, store and product views, impressions, checkouts, purchases, returns) are not gated; the seller already sees its own orders.

`releaseShopperTable(store, metric, dimension | null, gridWindow, grain)` is the **only** function that returns numbers for a shopper-gated metric, used by both the new series routes and the legacy gated aggregate routes (an aggregate is the same table with one column). It lives in the seller-analytics read repository (Kysely and in-memory adapters call one pure core, `packages/domain/src/seller-analytics/kanon-table.ts`), and reads **facts**, not rollups, because it needs exact union distinct counts.

**Why the earlier two-way design was replaced (ADR-0052, chief-reviewer findings).** (1) The column sums of a breakdown are released **ungated** at every window and grain (`seller.traffic.*` views, `seller.sales.orders`), so complementary suppression must treat them as always published, whatever their shopper count or memo state. (2) A memo that records only hidden aggregates lets a released cell change between reads (erasure NULLs `shopper_key`; late facts), so the difference of two reads isolates the changed shoppers. (3) The per-line rule is unsound even in a single request: with a = (r1,d1) at 5 shoppers, b = (r1,d2) hidden for row r1 and c = (r2,d1) hidden for column d1, column d2's hidden set {b} has >= 50 shoppers, so `b = col(d2) - released` and then `a = row(r1) - released - b`. The fixture `kanon-table.two-way-leak` reproduces this against the old core.

**Release ledger (persisted, immutable per aggregate).** Table `seller_analytics_suppression_memo` (migration 0090; the name is kept) holds one row per aggregate ever answered, keyed `(store_id, metric, dimension, dim_key, bucket)`. `bucket` is a Cairo day (non-additive series only) or a month. `state` is `hidden` (with `reason in (primary, complementary)`) or `released` (with the `value` served). DDL is in the track 6 migration plan. Rules:
- **A row is never updated.** Once hidden, always hidden; once released, every later read serves the **pinned** value, whatever later data arrive (late facts, erasure, re-delivery, reconciliation). If the recomputed value differs from the pinned one, the pinned value is still served and `seller_analytics_release_drift_total{metric}` increments (alert on any non-zero rate for a store).
- The ledger is written **before** the response leaves, in the same transaction as the reads, under `pg_advisory_xact_lock(hashtext(store_id || metric || dimension))`, so two concurrent gated reads for the same table serialise (cheap: gated routes are rate-limited). An insert that conflicts with a different existing state, or any insert failure, is 503 `seller_analytics_unavailable` (fail closed, never an unchecked release).
- The previous-period window goes through the same ledger.
- PII: P1 (no shopper key; released values are aggregates covering >= 50 shoppers). Retention: as long as the facts it protects (25 months), purged by the same job.

**External margins (registry).** Every additive gated (metric, dimension) declares `external_margin`, the ungated metric equal to its column sum: `seller.traffic.views` by `source` uses the ungated view totals, and `seller.geography.orders` by `governorate` uses `seller.sales.orders`. A CI test fails if an additive gated breakdown has no declaration. The algorithm assumes the external margin **equals** the column sum (worst case), even where unkeyed facts make it larger.

Algorithm for breakdowns (rows = dimension values, all of them, not only the top 10; columns = settled complete Cairo months of the window and of the previous-period window). Each column is handled independently:
1. Ledger first: a cell with a `released` row is pinned (value from the ledger; it is never a complementary candidate). A cell with a `hidden` row is hidden.
2. Primary: every other cell with fewer than 50 distinct `shopper_key`s is hidden; the rest are *tentatively released*.
3. Column check, repeated until stable: let H be the hidden cells of the column. The column is safe if H is empty, **or** the exact union `COUNT(DISTINCT shopper_key)` over H's facts is >= 50, **or** H is every cell of the column (its sum is then the ungated total, already public). Otherwise hide the tentatively released cell with the fewest distinct shoppers (ties: dimension key) and repeat. Union counts are exact SQL over facts read under the settle horizon.
4. Residual: if the column is still unsafe and no tentative cell is left, nothing new is released in it (every tentative cell is already hidden) and `seller_analytics_kanon_residual_total` increments. This can happen only after erasure lowers the union count of a hidden set that was released safely earlier, and the answer is then identical to the earlier one.
5. No internal margins: no row, multi-month or grand total is computed from gated cells. The column "total" in the response is the external metric's value, named in `external_total_metric`. If every cell of every column is hidden, `whole_series: true`.
6. Rows shown: the top 10 dimension values by the sum of their released cells over the window, plus at most one `other_released` row per column that sums only released cells of the remaining rows (those cells are pinned as `released` too).
7. Every newly hidden or newly released cell is inserted into the ledger.

Non-additive gated series (`unique_visitors`, `repeat_rate_bps`): each published number (day or month) is its own exact distinct count. It is released only if it covers >= 50 shoppers (primary only; there is no additive relation, so complementary suppression does not apply). It goes through the same ledger: pinned when released, hidden forever when hidden.

Soundness sketch: the published family is the released cells plus the external sums, and the external sums at any finer grain still cover every row. Cells of different months are disjoint. So every derivable sum of hidden cells is a combination of whole-column hidden sums, and each of those covers >= 50 shoppers or equals a public ungated total. Pinning means that no aggregate ever has two different published values.

**Changes to the pure core `kanon-table.ts`** (built, unwired; the builder rewrites it):
- Replace `releaseTable(table, rows, cols, memo)` with `releaseBreakdown(columns: readonly { col: string; cells: ReadonlyMap<string, Cell> }[], rows: readonly string[], ledger: ReadonlyMap<string, LedgerState>): BreakdownRelease`. Add `releaseDistinctSeries(points, ledger)` for non-additive series.
- `LedgerState = { state: "released"; value: number } | { state: "hidden"; reason: "primary" | "complementary" }`, which replaces `SuppressionMemo` and `EMPTY_MEMO`.
- `BreakdownRelease = { cells; counts: { primary; complementary; memo; pinned }; drift: readonly string[]; residualColumns: readonly string[]; wholeSeries; ledgerInserts: ReadonlyMap<string, LedgerState> }`. Drop `rowTotals`, `colTotals`, `grand` and `newlyHiddenMargins`.
- `extendMemo` becomes `applyLedger(ledger, inserts)`, which throws `LedgerConflict` when an insert differs from an existing state. `topRows` ranks by the sum of released cells.
- The core takes no clock. The adapter applies the settle horizon (`gatedWindow(request, now, settleHours)`) and the `ingested_at` filter.

**Existing weakness, fixed by this change (record for the DPO).** The legacy fold rule (`kAnonymizeAdditive`, `kanon.ts:60-85`: suppressed cells are added into the smallest released cell) **already leaks across overlapping legacy requests**: two windows that differ by one day can pick different fold targets, or fold different suppressed sets into the same target, so subtracting the two responses isolates a suppressed cell's value without any new series. ADR-0045 decision 4 and VR-DASH-02 are therefore not only a precondition for new breakdowns; they are the fix for a weakness in production code today, which the DPO should weigh when deciding (VR-DASH-05). Until the decision, the safe default keeps legacy behaviour unchanged (no new channel added), and this spec does not add any further gated surface.

### `unique_visitors` gated by default (M5)
`seller.traffic.unique_visitors` (legacy `traffic.unique_visitors` and the series) releases 1 to 49 per day with no k gate today (F11). Safe default, applied **now** in track 4 (it only reduces disclosure, no flag): below 50 distinct shoppers the value is suppressed (`null`, with `unique_visitors_suppressed: true` on the legacy wire), exactly like `repeat_rate`. The series metric is shopper-gated (grid presets, memo, DPO flag). Releasing it ungated is an owner decision (DPO, VR-DASH-06).

### Endpoints
Seller (additive; the nine existing routes keep their shapes):
- `GET /v1/seller/stores/{storeId}/analytics/series/{metricId}?from&to&grain&compare` (ungated metrics) or `?preset&grain&compare` (gated metrics; `from`/`to` with a gated metric is 400 `window_not_on_grid`) returns `MetricSeries`. Gated metric ids answer 404 while `release.seller_analytics.shopper_series` is blocked.
- `GET /v1/seller/stores/{storeId}/analytics/series/{metricId}/breakdown?preset&grain&dimension` returns `MetricBreakdownSeries` (flag `release.seller_analytics.shopper_series`, DPO-controlled, blocked until VR-DASH-02 and VR-DASH-05). This flag **replaces** `release.seller_analytics.breakdown_series`, which is removed before merge (never released).
- `GET /v1/seller/stores/{storeId}/analytics/summary?from&to` returns `{ tiles: MetricSeries[4] }` at day grain for `seller.sales.gmv`, `seller.sales.orders`, `seller.funnel.conversion_bps`, `seller.sales.net_after_commission`. Net *payable* (after holds and refunds) is not shown: payout visibility is an owner decision (ADR-0049). This replaces the unscoped `/v1/seller/analytics/summary` (ADR-0050).
- Gate: the existing seller-analytics resolver and policy (`store_order` read; foreign store 404), unchanged.
- Rate limit 60/60 s per user per store; `Cache-Control: private, max-age=60`; strong `ETag` = SHA-256 of (metric id, version, snapped window, grain, compare, store, `as_of`, rollup reconciliation epoch); `If-None-Match` answers 304 **after** authorization, computed from the freshness row without running the aggregate.

Seller metric registry v1 (closed enum `SellerMetricId`):

| id | unit | additive | basis | gated |
|---|---|---|---|---|
| `seller.sales.gmv`, `seller.sales.commission`, `seller.sales.net_after_commission` | piastres | yes | rollup | no |
| `seller.sales.orders`, `seller.sales.units` | count | yes | rollup | no |
| `seller.sales.aov` | piastres | no | rollup (ratio of two rollups) | no |
| `seller.traffic.store_views`, `seller.traffic.product_views` | count | yes | rollup | no |
| `seller.traffic.unique_visitors` | distinct_shoppers | no | exact_facts | **yes** (M5: suppressed below 50; grid presets; DPO flag) |
| `seller.funnel.impressions`, `.views`, `.saves`, `.bags`, `.checkouts`, `.purchases` | count | yes | rollup | no |
| `seller.funnel.conversion_bps` (purchases / product views) | bps | no | rollup | no |
| `seller.returns.units` | count | yes | rollup | no |
| `seller.returns.rate_bps` (returned units / sold units, same bucket of sale) | bps | no | exact_facts | no |
| `seller.sales.repeat_rate_bps` | bps | no | exact_facts | yes (>= 50 purchasers per bucket, else suppressed; DPO flag) |
| `seller.traffic.views` with `dimension=source` | count | yes | exact_facts | yes (DPO flag) |
| `seller.geography.orders` with `dimension=governorate` | count | yes | exact_facts | yes (DPO flag) |

`seller.returns.rate_bps` is a ratio of unit counts, not of shoppers, so it is not gated; it stays `exact_facts` because returns are attributed to the bucket of sale.

Admin:
- `GET /v1/admin/metrics/{metricId}?from&to&grain&compare` returns `MetricSeries`. Registry v1, platform-wide, no shopper breakdowns, so no k-gate: `platform.orders.placed`, `platform.seller_orders.placed`, `platform.orders.purchased`, `platform.units.purchased`, `platform.gmv.purchased` (piastres), `platform.aov` (piastres, ratio), `platform.stores.with_purchase` (distinct stores, non-additive).
- Gate (ADR-0049 Proposed default): count metrics need `metrics.read.counts` (ops, finance); money metrics need `metrics.read.money` (finance). Passkey required. Every allowed read is counted, every deny audited. The owner may widen the role table; the code reads it from one constant.
- Rate limit 60/60 s per user; `Cache-Control: private, no-cache` plus ETag (admin pages must always revalidate).
- Budget, measurement and personalisation tables are never sources (existing boundary tests extended to the new module).

### Basis and `as_of`
- `rollup`: `as_of` = the consumer's low watermark `analytics_rollup_watermarks.applied_through` (track 6). `rollup_reconciled` once the bucket has passed a reconciliation run with zero mismatches.
- `exact_facts`: `as_of` = `seller_analytics_freshness.last_ingest_at` (existing).
- `notes: consent_sampled` on every client-event-derived metric (views, impressions, saves, bags, unique visitors): they under-count shoppers without `analytics` consent (track 5).

### Edge cases
Zero data (all points `ok` with 0 for additive, `null` for ratios); a store created mid-window (points before `stores.created_at` are `not_measured`); launch period (`notes: launch_period` when the window starts before the first ingested event); future `to` (clamped); a window crossing both DST changes; an unknown metric id (404 `unknown_metric`, same body for seller and admin, no enumeration of other stores); a metric whose source is unconfigured in production (503 `metric_source_unconfigured`, never zeros).

### Security and abuse (STRIDE)
- S: store from path is resolved and compared with grants (404 foreign). T: read-only. R: seller reads counted; exports unchanged (audit first). I: k-gate in one function; `shopper_key` never selected into any wire type (existing test extended to new types). D: point caps, rate limits, ETag, statement timeout 2 s on fact scans, the 366-day cap. E: admin money metrics require finance.
OWASP API4 (resource consumption) via caps; API1 via resolver; API3 via explicit serializers.

### Tests required
- Negative authorization: seller A on store B series 404 (body equals missing store); buyer and admin tokens on seller routes 401; seller token on admin metrics 401; marketing on money metric 403; ops on money metric 403; finance without passkey 403.
- Property tests (fast-check, 1,000 runs each):
  - Bucketing: every instant in a random 3-year range maps to exactly one hour and one day bucket; day `hours` is in {23, 24, 25}; hours per year are 8,760 or 8,784; fixtures 2026-04-24 = 23, 2026-10-29 = 25, 2027-04-30 = 23, 2027-10-28 = 25; spring day starts at local 01:00.
  - Day sums: for additive metrics, the sum of day points equals the window total and equals the sum of hour points over the same window.
  - Previous period: same bucket count; index alignment; `no_bucket` appears only at DST slots.
  - **k-anonymity audit (the shared oracle, ADR-0052):** the published family is every released cell, every pinned value and the external margin of every column (treated as published regardless of shopper count). Gaussian elimination over the rationals gives the row space of that family restricted to hidden cells. For every subset S of hidden cells (tables up to 4 rows x 4 months, so at most 16 hidden cells), if the indicator of S is in that row space, then union(S) >= 50 or S is a whole column. Every k-anonymity property below uses this oracle. The committed fixture `kanon-table.two-way-leak` (the a, b, c counterexample) must fail the oracle against the old two-way `releaseTable` and pass against `releaseBreakdown`.
  - k-anonymity, single request: random fact sets with shopper overlap across cells and columns pass the oracle; no released cell has < 50; replay is deterministic; the response has no row, multi-month or grand total derived from gated cells.
  - **k-anonymity, overlapping requests (B2):** on a 14-month synthetic calendar, take any sequence of up to 5 requests over random presets (`month:`, `last_full_months:{1,3,6,12}`), `compare` on and off, and both routes (legacy gated field and series). Between requests, apply events: late facts both before and after the settle horizon, erasures (NULL keys), new dimension values and clock advances across the settle horizon. The union of all responses, plus the external margins as of each request time, passes the oracle. Every aggregate shows **one value across all responses** (pin). A shrunk counterexample is committed as a regression fixture.
  - **Ledger monotonicity and pinning:** once hidden, an aggregate is hidden in every later response that contains it, including after late data push it above 50. Once released, every later response serves the identical value after erasure of a contributing shopper or after late facts, and the drift counter increments when the recomputed value differs. A residual column changes no aggregate's state. `applyLedger` rejects a conflicting insert.
  - **Settle horizon:** a fact with `ingested_at > bucket_end + S` never changes a gated value; a bucket with `now < bucket_end + S` is not released; ungated rollups still include the late fact.
  - **External-margin registry:** every additive gated (metric, dimension) declares `external_margin`. On random facts, the column sum of gated cells is <= the external metric's value for the same Cairo month, and equal when every fact is keyed.
  - **Cross-route mixed time zones (B1):** requests whose `from`/`to` instants use `Z`, `+02:00` and `+03:00` offsets, around both DST transitions (2026-04-24, 2026-10-29) and month boundaries, through every legacy gated route and every gated series, all resolve through `gatedWindow` to the same month set. The ungated hour series over the same instants, summed to Cairo months and to UTC days, reproduce the external margins the oracle uses, so the legacy UTC-day ungated totals are inside the audited family. The combined responses pass the overlapping-requests property. A test fails if any gated read path calls `snapToDays`.
  - Legacy fold weakness (documentation test): a committed fixture shows two overlapping legacy requests under `kAnonymizeAdditive` isolating a suppressed value; it must fail (leak detected) on the legacy path and pass under `releaseShopperTable`, so the DPO evidence is reproducible.
  - `unique_visitors` (M5): a day with 49 distinct visitors returns `null` and `unique_visitors_suppressed: true` on the legacy route; 50 returns 50.
  - Money: all arithmetic in bigint; no float in the series path (lint rule plus test with values above 2^53).
- Contract: generated client parses every registry metric response; OpenAPI enum equals the registry.
- Mutation targets (>= 80 %): `kanon-table.ts`, `cairo.ts` bucketing, previous-period alignment, ratio and banker's rounding helpers, ETag key builder.

### Rollout
Flags: `release.seller_analytics.series` (ungated series and the summary route only), **`release.seller_analytics.shopper_series`** (DPO-controlled; every shopper-gated series and breakdown, plus the switch of legacy gated fields to `gatedWindow` and `releaseShopperTable`; blocked until VR-DASH-02 and VR-DASH-05 are Verified or Accepted risk), `release.admin.metrics`. The M5 suppression of `unique_visitors` below 50 ships without a flag. CR checkpoint (personal data: k-anonymity) before `shopper_series` is allowed anywhere with real data. In production all series also need producers (`kill.analytics.producers`, track 5); without them the routes answer with `as_of: null` (no data yet), never zeros.

---

## 5. Track 5: event publishers and the `EventSourcePort`

### What is server-derived and what mobile emits
| Read-model kind | Origin | Producer (same transaction as) | Consent |
|---|---|---|---|
| `checkout` (per store) | server | checkout saga, when SellerOrders are created (`seller_order.placed`, one per SellerOrder, one line list) | `shopper_key` set only if the user has `analytics` consent; the fact is written either way |
| `purchase` (per line) | server | orders, on the `PAID` or `CONFIRMED_COD` transition (`order_line.purchased`, one per line) | same rule |
| `return` (per line) | server | returns, on `RETURN_RECEIVED` (`return_line.received`) | same rule |
| `stock_snapshot` | server | inventory, on any change of `inventory_levels.on_hand` or `committed` (`inventory.level_changed`, one per SKU per transaction, coalesced) | none (not personal) |
| `impression` | **mobile** | new client event `product_impressions` (batched) | `analytics` consent (client tracker gate plus server re-check) |
| `store_view`, `view`, `bag`, `save`, `search_click` | **mobile** | existing client events `store_viewed`, `product_viewed`, `add_to_bag`, `wishlist_added`, plus `search_result_clicked` | `analytics` consent |

Why: purchases, returns, checkouts and stock are records the platform already holds; deriving them on the server is exact and cannot be spoofed. Impressions and views exist only on the device. The "facts written, shopper key only with consent" rule keeps sellers' GMV and order counts complete (they already see their orders) while distinct-shopper metrics count only consenting shoppers.

**Writing these facts for seller reporting is an owner and counsel decision, not an engineering default (B3).** Whether checkout, purchase and return facts (with `governorate`, `size_label` and, with consent, `shopper_key`) may be kept in a separate analytics store for seller reporting is the lawful-basis question VR-DASH-03 (the inventory records `legitimate_interest` with `verify: true`). Recorded as **Proposed** in ADR-0045 decision 5. Safe default: the server producers are built but sit behind the new kill switch **`kill.analytics.producers`** (allowed-when-true, default blocked, ADR-0028): while blocked, the producing transitions append nothing to the outbox, so no analytics fact or `shopper_key` exists anywhere. It may be allowed only after VR-DASH-03 is Verified or Accepted risk, with a CR checkpoint. `stock_snapshot` carries no personal data but shares the switch so that the analytics pipeline has one on/off point.

### Server event payloads (outbox; P1 except `shopper_key`, which is P2; amounts as strings)
- `seller_order.placed` v1: `seller_order_id, order_group_id, store_id, placed_at_ms, lines[{product_id, sku_id, qty}] (<= 50), shopper_key | null`.
- `order_line.purchased` v1: `order_line_id, seller_order_id, store_id, product_id, sku_id, qty, gross_minor, commission_minor, size_label, governorate | null, purchased_at_ms, shopper_key | null, currency: "EGP"`. `gross_minor` = line merchandise gross after item-level discounts (the existing `sales` definition); `commission_minor` from the SellerOrder's `commission_rate_snapshot`, computed with the existing domain function; `governorate` from the delivery snapshot (coarse, P1; never the address).
- `return_line.received` v1: `return_id, order_line_id, store_id, product_id, sku_id, qty, reason, received_at_ms, shopper_key | null`.
- `inventory.level_changed` v1: `sku_id, store_id, on_hand_total, committed_total, level_version, changed_at_ms` (totals summed over locations inside the transaction).
- `shopper_key` = HMAC-SHA256 of `user_id` with the analytics pseudonym key and purpose `seller-analytics`, using `packages/analytics/src/pseudonym.ts`, rotated yearly (T6). It is never derivable back to a user by sellers; repeat rate across a rotation boundary under-counts (documented).
- Producers append inside the transaction that already exists; no money behaviour changes (same rule as `commerce-events.md`). Each producer checks `kill.analytics.producers` once per transaction (flag read from the in-process snapshot, never a network call inside the money transaction); blocked means skip the append, never fail the transition.
- **Outbox payloads are personal data while they exist (H3).** `seller_order.placed`, `order_line.purchased`, `return_line.received` and `analytics.client_batch` carry `shopper_key` (P2) and, for purchases, `governorate` (P1) and `size_label`. They stay in `outbox_events.payload` until the `outbox.published` purge (30 days after publish, `retention/domain/catalog.ts:32`, `retention-schedule.md:43`) or indefinitely while unpublished. `data_inventory.yaml` gets a `payload` field entry on `outbox_events` (P2, purpose `seller_analytics`, retention `technical_dedup`, `on_erasure: erase_keys`, note naming these event types); the erasure flow (track 6) also covers unpublished payloads.

### Client ingest (new)
`POST /v1/analytics/events` · audience `buyer_api` · scope `shopper` · idempotent by `event_id` per event and `Idempotency-Key` per batch · rate limits keyed on **user and session** (the session id from the verified token), never on the client install id, which is unattested (H2): 60 batches per 60 s per (user, session), 600 events per 60 s per user · body <= 64 KB · **App Attest or Play Integrity required** (`X-App-Attest`, `X-Client-Platform`) before ingest is allowed for real users.

```yaml
AnalyticsEventBatch:
  type: object
  additionalProperties: false
  required: [sent_at, events]
  properties:
    sent_at: { type: string, format: date-time }
    events: { type: array, minItems: 1, maxItems: 50, items: { $ref: "#/components/schemas/AnalyticsClientEvent" } }
AnalyticsClientEvent:
  oneOf:          # discriminator: name; every variant additionalProperties: false
    - { name: store_viewed,          event_id, occurred_at, properties: { store_id, source } }
    - { name: product_viewed,        event_id, occurred_at, properties: { store_id, product_id, source } }
    - { name: product_impressions,   event_id, occurred_at, properties: { surface, items: [{ product_id, store_id, position }] (<= 30) } }
    - { name: add_to_bag,            event_id, occurred_at, properties: { store_id, product_id, source } }
    - { name: wishlist_added,        event_id, occurred_at, properties: { product_id, intent } }
    - { name: search_result_clicked, event_id, occurred_at, properties: { store_id, product_id, term } }
AnalyticsIngestResult: { accepted: integer, duplicates: integer, rejected: integer }
```
- `source` and `surface` are closed enums: `feed, search, stylist, shared_link, ads, creators, my_stores, store_page, other` (closes the "7-source taxonomy not enforced" gap in the seller catalogue).
- Strict Zod at the boundary: **any** key not listed fails the event, and keys named `user_id`, `phone`, `email`, `address`, `dob`, `measurements` or matching `^budget_` fail the whole batch with 400 `forbidden_property` (defence in depth: the client must never send them).
- **Search terms (M9).** `term` is shopper free text and is classed **P2** as stored today (`data_inventory.yaml` must say so now); after this design the clear `term` holds catalogue vocabulary only (P1) and the keyed `term_hash` is P2 (track 6). The review asked to reuse the privacy module's name heuristics; **none exist** (finding F6), and a name blacklist cannot be complete for Arabic, English and Franco-Arabic names. Design instead:
  1. The existing normaliser runs first (`seller-analytics/domain/ports.ts:18-31`), extended with the `llm-gateway/domain/scrub.ts` patterns (phone with separators, email, URL) so both paths reject the same shapes.
  2. **Vocabulary allow-list:** the raw term is stored only if every token is in the search vocabulary (category names, attribute values, brand names and synonyms from the search module's dictionaries, AR, EN and Franco). A person's name that is not also a catalogue word therefore never reaches storage in clear.
  3. Every other term is stored only as `term_hash` = HMAC-SHA256 (analytics pseudonym key, purpose `search-term`) and is never released as text; it counts toward an "other terms" total that is itself k-gated. Terms below the minimum length are dropped.
  4. Released terms keep the existing k >= 50 distinct-shopper gate.
- **Plausibility, server side (H2).** Before the outbox write, per user (the identity is still known at this point and is dropped right after):
  - Dedupe `(user, product, surface)` within 15 minutes for impressions and views (Redis `SET NX EX 900` on an HMAC of the triple; duplicates counted, not stored).
  - At most 30 impressions per surface per user per minute; the excess is rejected and counted.
  - Reject impossible timing: `sent_at` more than 5 minutes ahead of server time; any `occurred_at` later than `sent_at` + 5 s; `occurred_at` outside 7 days before to 5 minutes after server time; duplicate `position` values inside one `product_impressions` event.
  - Redis unavailable: the batch is 503 (fail closed; the tracker retries), never accepted unchecked.
- **Attestation (H2).** A valid App Attest or Play Integrity token is required for every batch once ingest is allowed for real users; missing or invalid is 401 `attestation_required`, counted. The attestation verifier still passes an empty challenge (`auth/application/common.ts:25-30`, VERIFY), so enabling it for ingest is a **Security decision** (VR-DASH-07). Until then ingest stays blocked for real users (`kill.analytics.ingest`), and only synthetic test traffic uses it in non-production with the fake verifier.
- **Per-store anomaly guard (H2).** The consumer compares each store's impressions (and views) per Cairo hour with the median of the same hour over the previous 7 days. Above `max(10 x median, 500)` the bucket's client-derived increments are written to the facts but **not published**: the rollup cell is marked held, series points show `state: held` with `notes: anomaly`, and an Ops ticket is opened. Ops releases or discards the held increments after review (audited). Server-derived facts (purchases, returns) are never held.
- Server consent re-check (M4): the API reads the user's `analytics` consent **on every batch, uncached** (one indexed read on `consent_records`; at the rate limits above this is at most one read per second per session). Without consent: 202 with `accepted: 0`, nothing stored, nothing logged except a counter. The tracker already does not send without consent; the re-check covers a stale client. Caching is not used because a withdrawal must take effect on the next batch.
- The server replaces the authenticated identity with `shopper_key` before writing and keeps no user id, device id or IP with the event.
- Storage: one `outbox_events` row per accepted batch (`aggregate_type = 'analytics_batch'`, `event_type = 'analytics.client_batch'`, payload = validated events with `shopper_key`, no user id). Facts keep per-event `message_id = event_id`, so a re-sent event is a duplicate even inside a new batch.
- App Attest or Play Integrity: required before real users (above). The mobile client already sends `X-App-Attest` on sign-in; the ingest call reuses the same token provider (no new dependency).

Mobile tasks (separate track, Phase A only adds emission): emit `product_impressions` from feed, search, store page and stylist lists when a card is at least 50 % visible for 1 s, deduplicated per (product, surface) per session, batched every 15 s or 30 items; send batches through the existing consent-aware tracker to the new endpoint; add the event to `packages/analytics` taxonomy and `docs/analytics/events.md` (regenerated).

### `EventSourcePort`
The port stays (`poll`, `ack`) for tests and for a future ClickHouse source. Production adds a **relay push** adapter instead of polling: the existing relay (`apps/api/src/production/relay.ts`) routes `seller_order.placed`, `order_line.purchased`, `return_line.received`, `inventory.level_changed` and `analytics.client_batch` to the `seller-analytics` consumer and to the `platform-metrics` consumer, each under its own inbox consumer name, inside the inbox transaction (same pattern as the creators and orders routes). This replaces `unconfigured("analytics.warehouse")` for the outbox-fed kinds; the ClickHouse adapter remains Unconfigured.
- Idempotency: inbox `(consumer, message_id)` plus the facts primary key `message_id`.
- Replay: consumers are idempotent, so replay = clear `published_at` for the rows (existing relay mechanism) or run `analytics.replay --from --to --types` (worker command), which re-delivers; rollups are re-derivable from facts (track 6), so a replay can never double-count.
- Poison messages: acked and counted (existing consumer rule); `outlet.analytics.ingest.rejected{reason}` alerts above 1 % of a 10-minute window.
- Ordering: not required (facts are append-only; stock uses `level_version` and keeps the highest).
- Stock enrichment: the consumer looks up `price_minor`, `size_label`, `listed_at` from catalog through the existing `ProductStoreLookup`-style port (production binding currently `internal()`, must be bound; dependency). Snapshot price is the price at consume time (documented).

### Failure handling
Relay retries with backoff and dead-letters after 8 attempts (existing). A consumer blocked by `kill.analytics.consumers` is simply not registered, so events are acknowledged unrouted and stay replayable. Ingest: the outbox insert is the only write; a DB error is 503 and the client keeps the batch for its next flush (tracker buffer, max 500 events, oldest dropped and counted).

### Security and abuse (STRIDE)
- S: ingest requires a buyer session and device attestation; store and product ids are checked to exist and to match (`store_id` must own `product_id`) at consume time, mismatches rejected, so one user cannot inflate a competitor's funnel with fake product ids. Rate limits on user and session (not the unattested install id), per-triple dedupe, per-surface caps and the per-store anomaly guard bound inflation by many accounts; inflation has no money effect, but funnel numbers feed seller decisions and ranking, so held buckets are never published unchecked.
- T: payloads immutable in outbox. R: counters per rejection reason. I: no user or device id stored; forbidden keys rejected. D: body and rate caps; batches coalesce into one outbox row. E: no write to any other table.
OWASP API6 (sensitive business flows) is mitigated by caps and later attestation; API8 by strict schemas.

### Tests required
- Ingest negative: seller and admin tokens 401; no token 401; missing or invalid attestation 401 `attestation_required`; batch with `user_id`, `measurements`, `budget_x`, `phone` or an unknown key 400 and nothing stored; 51 events 400; body > 64 KB 413; user without consent 202 `accepted: 0` and no outbox row; **withdraw consent, then send a batch within 1 s: `accepted: 0`** (M4); `occurred_at` out of range, `occurred_at` after `sent_at` + 5 s, `sent_at` in the future: rejected and counted; 31st impression on a surface in one minute rejected; the same (product, surface) twice within 15 minutes counted once; Redis down 503; product of another store rejected at consume; the 61st batch from one session in a minute 429 while a second session of the same user is still accepted up to the user cap.
- Terms (M9): a term containing a phone with separators, an email or a URL is rejected; a term with a non-vocabulary token is stored only as `term_hash` (no clear text in facts or outbox); a vocabulary term with 49 distinct shoppers is not released, with 50 it is.
- Anomaly guard: an impression spike above 10 x the 7-day median marks the bucket `held` with `notes: anomaly`, no published point shows the spiked value, server-derived facts in the same hour are unaffected; release by Ops writes an audit row.
- Producers: with `kill.analytics.producers` blocked, every emitting transition appends **no** analytics event (test per producer) and the money transition still commits; allowed, each emitting transition writes exactly one event per seller order or line inside the same transaction (rollback test: abort the transaction, no event); payload Zod round-trip; `shopper_key` null without consent; amounts equal the existing `sales` computation for the same order (property).
- Replay: delivering every message twice, in random order, yields identical facts and rollups (property).
- Boundary: `analytics-ingest` and `platform-metrics` modules cannot import budget, sizing measurements or personalisation modules (dependency-cruiser rule plus `boundaries.test.ts`).
- Mutation targets: the ingest validator, consent re-check branch, client-to-SourceEvent mapper.

### Rollout
- `kill.analytics.producers` (**new**, blocked: server producers append nothing; allow only after VR-DASH-03 is Verified or Accepted risk, with a CR checkpoint).
- `kill.analytics.ingest` (blocked: 503 `analytics_ingest_disabled`; the tracker drops batches and counts). Allow for real users only after VR-DASH-03 **and** VR-DASH-07 (attestation) are Verified or Accepted risk, with a CR checkpoint.
- `kill.analytics.consumers` (blocked: consumers not registered; events are acknowledged unrouted and stay replayable only until the 30-day `outbox.published` purge).
- Building the producers, the ingest route and the consumers behind these switches is GO now (synthetic data and fakes only); enabling any of them with real users is blocked (section 8).

---

## 6. Track 6: rollup tables by Cairo hour

### Approach decision (ADR-0045)
| Option | Complexity | Accuracy | Cost | Scalability |
|---|---|---|---|---|
| A. Outbox consumers increment rollups in the inbox transaction, plus a reconciliation job that recomputes recent buckets from facts | medium | exact for additive counters (exactly-once effect via inbox); late events land in their own bucket; reconciliation repairs any defect | one upsert per key per batch | good; hot keys pre-aggregated per batch |
| B. Scheduled recompute only (every 15 min re-aggregate the last N hours from facts) | low | exact at recompute time but stale up to the period; late events older than N are missed unless a nightly full pass runs | rescans facts every period, grows with volume | degrades with volume |
| C. ClickHouse materialised views | high | exact | new infrastructure, residency blocked by ADR-0002 | best |

Choice: **A for additive counters, with B's recompute as the repair path (the reconciliation job), and C deferred.** Consumers keep the 15-minute freshness SLO cheaply and idempotently; the reconciliation job bounds any drift without rescanning all facts every 15 minutes. Distinct-shopper and k-gated metrics never use rollups (they stay on exact facts, track 4).

### Data (migration `0088_analytics_rollups.sql`, expand only)
```sql
CREATE TABLE seller_analytics_hourly (
  store_id        uuid NOT NULL,
  metric          text NOT NULL CHECK (metric IN ('gmv_minor','commission_minor','orders','units','store_views','product_views',
                    'impressions','saves','bags','checkouts','purchases','returned_units')),
  hour_utc        timestamptz NOT NULL CHECK (date_trunc('hour', hour_utc) = hour_utc),
  cairo_date      date NOT NULL,
  cairo_hour      smallint NOT NULL CHECK (cairo_hour BETWEEN 0 AND 23),
  utc_offset_min  smallint NOT NULL CHECK (utc_offset_min IN (120, 180)),
  value           bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  held_value      bigint NOT NULL DEFAULT 0 CHECK (held_value >= 0),   -- anomaly guard (track 5): not published until released
  version         bigint NOT NULL DEFAULT 0,                           -- bumped by every write; reconciler compare-and-set (M1)
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, metric, hour_utc)
) PARTITION BY RANGE (hour_utc);
-- M2: the migration creates the DEFAULT partition and the monthly partitions for the current month and the next 5
-- (6 in total); the partition job keeps at least 3 months ahead from then on.
CREATE TABLE seller_analytics_hourly_default PARTITION OF seller_analytics_hourly DEFAULT;
CREATE INDEX sah_store_metric_date_idx ON seller_analytics_hourly (store_id, metric, cairo_date);

CREATE TABLE platform_metrics_hourly (
  metric          text NOT NULL CHECK (metric IN ('orders_placed','seller_orders_placed','orders_purchased','units_purchased','gmv_purchased_minor')),
  hour_utc        timestamptz NOT NULL CHECK (date_trunc('hour', hour_utc) = hour_utc),
  cairo_date      date NOT NULL,
  cairo_hour      smallint NOT NULL,
  utc_offset_min  smallint NOT NULL CHECK (utc_offset_min IN (120, 180)),
  value           bigint NOT NULL DEFAULT 0 CHECK (value >= 0),
  version         bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (metric, hour_utc)
) PARTITION BY RANGE (hour_utc);
CREATE TABLE platform_metrics_hourly_default PARTITION OF platform_metrics_hourly DEFAULT;   -- plus 6 monthly partitions

CREATE TABLE analytics_rollup_watermarks (
  consumer        text PRIMARY KEY,
  applied_through timestamptz NOT NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analytics_rollup_reconciliations (
  id              uuid PRIMARY KEY,
  scope           text NOT NULL CHECK (scope IN ('seller', 'platform')),
  window_from     timestamptz NOT NULL,
  window_to       timestamptz NOT NULL,
  checked_rows    integer NOT NULL,
  mismatches      integer NOT NULL,
  corrected       integer NOT NULL,
  skipped_concurrent integer NOT NULL DEFAULT 0,
  outcome         text NOT NULL CHECK (outcome IN ('ok', 'corrected', 'error')),
  ran_at          timestamptz NOT NULL DEFAULT now()
);
-- RLS (concrete roles, finding F1; 'admin' is not a valid app.role):
--   seller_analytics_hourly: SELECT USING (store_id::text = ANY (app_store_ids()) OR app_role() = 'system'); writes system only.
--   platform_metrics_hourly: SELECT USING (app_role() IN ('ops','finance','system')) (the ADR-0049 metrics roles); writes system only.
--   watermarks, reconciliations: SELECT USING (app_role() IN ('ops','finance','security','system')); writes system only.
--   The admin metrics route reads under the role that satisfied its gate; workers write under asSystemRole.
```
- **DEFAULT partition alert (M2):** a row in a DEFAULT partition means the partition job fell behind. Gauge `outlet.analytics.rollup_default_partition_rows{table}` (cheap `count(*)` on the DEFAULT partition, exported by the partition job and by the API every collection) with a Prometheus rule `> 0 for 10m` ticketing Platform; the partition job, when it creates a missing month, moves the DEFAULT rows into it (detach DEFAULT, create the month, re-insert, re-attach, in one transaction).
- `stores.with_purchase` (distinct stores) is computed from `seller_analytics_hourly` (`COUNT(DISTINCT store_id) WHERE metric='purchases' AND value > 0`) under the system role inside the platform-metrics adapter; it is non-additive.
- Day, week and month queries aggregate hourly rows by `cairo_date` (at most 9,150 rows per store per metric per year), so day and hour can never disagree.
- PII: rollups hold no shopper key; class P1 aggregates; `data_inventory.yaml` entries required for all four tables.
- Retention: hourly rollups 25 months (same rule as analytics events), purged by dropping whole monthly partitions; reconciliation rows 2 years; suppression memo 25 months.

### Facts retention and erasure (H3)
`seller_analytics_facts.shopper_key` is **P2**; `term` is P2 until the M9 vocabulary rule ships (afterwards `term` holds catalogue words only, P1, and the new `term_hash` column is P2); the catalog text at `retention/domain/catalog.ts:76` ("The remaining tables are aggregates or not personal") is wrong and is corrected in this track.
- **Purge target:** retention catalog entry `seller_analytics.facts` (rule `analytics_events`, 25 months, VR-DASH-04), `action: delete`, age `t.occurred_at`, batched 5,000 rows per statement. **Index option compared:** (a) a plain `CREATE INDEX CONCURRENTLY sa_facts_occurred_idx ON seller_analytics_facts (occurred_at)` with batched deletes; (b) convert facts to monthly range partitions and drop partitions. (b) is cheaper per purge at volume but requires a contract migration of an existing table (copy, swap, constraint rebuild) and changes the primary key to include `occurred_at`; (a) is one expand migration and adequate at Phase A volume (no production producer yet). **Choice: (a) now**, with (b) recorded as the path when facts exceed about 50 million rows (ADR when needed).
- **Grants:** facts are `SELECT, INSERT` only today (finding F10). Migration 0090 adds `GRANT DELETE ON seller_analytics_facts TO app_user` with policy `sa_facts_delete FOR DELETE USING (app_role() = 'system')`, and `GRANT UPDATE (shopper_key) ON seller_analytics_facts TO app_user` with policy `sa_facts_erase FOR UPDATE USING (app_role() = 'system') WITH CHECK (app_role() = 'system')`. A trigger `sa_facts_erase_only_trg` rejects any UPDATE that changes a column other than `shopper_key`, or sets it to anything but NULL. 0090 also adds `term_hash text CHECK (term_hash IS NULL OR term_hash ~ '^[0-9a-f]{64}$')` and replaces `sa_facts_search_chk` with `kind <> 'search_click' OR term IS NOT NULL OR term_hash IS NOT NULL` (`NOT VALID`, then `VALIDATE`).
- **Erasure, before the user row is erased:** the privacy erasure flow (`privacy.process-deletions`) calls a new exported use case `forgetShopper(userKey)` in seller-analytics, which:
  1. computes every live pseudonym for that user: for each key version still held in KMS and each rotation epoch (UTC year) overlapping the 25-month retention window, `derivePseudonymousId(userKey, epoch)` (`packages/analytics/src/pseudonym.ts:90-100`); at most 3 epochs times the active key versions;
  2. `UPDATE seller_analytics_facts SET shopper_key = NULL WHERE shopper_key = ANY($keys)` in batches (NULL rather than re-pseudonymising: a fresh random key would still let a seller-side count link the erased person's events to each other), using a new partial index `sa_facts_shopper_idx ON seller_analytics_facts (shopper_key) WHERE shopper_key IS NOT NULL` (the covering index leads with `store_id` and cannot serve this);
  3. records the computed keys in `analytics_erased_keys(shopper_key, erased_at)` for 31 days (longer than the 30-day outbox purge), so a consumer that later ingests an older unpublished outbox payload replaces a matching `shopper_key` with NULL at ingest;
  4. completes before the erasure flow erases the user row (the flow treats a failure as a retryable step and does not proceed). Rollups hold no shopper key and are unchanged. The release ledger (ADR-0052) pins every gated aggregate, so erasure can neither release a previously hidden cell nor change a previously released value, which would let two reads be subtracted to isolate the erased shopper. Pinned aggregates covering >= 50 shoppers keep the erased shopper's contribution; this is a DPO decision under VR-DASH-02.
- **Outbox payloads** (track 5) holding `shopper_key` are covered by step 3 and by the 30-day purge.
- `data_inventory.yaml`: facts `shopper_key` P2 with `on_erasure: null_field`, `term` P1 (vocabulary only) and `term_hash` P2; `outbox_events.payload` P2 note; `analytics_erased_keys` P2, retention 31 days, purpose `erasure_propagation`.

### Consumer write rule
Inside the existing `AnalyticsStore.ingest` transaction (inbox row, facts insert): pre-aggregate the batch's additive deltas per `(store, metric, hour)` in memory, take `pg_advisory_xact_lock(rollup_key_hash(store, metric, hour))` for each key **in sorted order**, then one `INSERT ... ON CONFLICT (store_id, metric, hour_utc) DO UPDATE SET value = seller_analytics_hourly.value + EXCLUDED.value, version = seller_analytics_hourly.version + 1, updated_at = now()` per key (sorted, so lock order is consistent and deadlocks are avoided). Client-derived increments in a bucket the anomaly guard holds go to `held_value` instead of `value`. `rollup_key_hash` is one exported SQL function (`hashtextextended(store || metric || hour, 0)`) used by consumer and reconciler alike. A duplicate message is rejected by the inbox before any increment. `applied_through` is set at the end of each batch to the minimum of `now()` and the oldest `occurred_at` among outbox rows of routed types still unpublished (a bounded query on `outbox_events_unpublished_idx`).

### Reconciliation job
`analytics.reconcile-rollups`: every hour for the last 48 hours, and nightly at 04:00 Cairo for the last 35 days.

Race analysis (M1). The earlier draft locked rollup rows and then read facts, which misses **new keys** (no row to lock: a consumer can insert the key between the reconciler's facts read and its insert). A rule of "skip rows with `updated_at` after the run start" is also unsound on its own, because `now()` is the **transaction start** time: a consumer transaction that started before the run but committed during it carries an older `updated_at` and would be overwritten with a stale recomputed value. The design therefore uses a version compare-and-set:
1. **Read phase**, one `REPEATABLE READ` transaction: read the rollup rows `(key, value, version)` of the window and `SUM` the facts for the same window. Because a consumer writes its facts and its rollup increment in one transaction, this snapshot is consistent: either both or neither are visible.
2. **Existing keys**, one `READ COMMITTED` transaction per batch of mismatches: `UPDATE ... SET value = :recomputed, version = version + 1, updated_at = now() WHERE (store_id, metric, hour_utc) = :key AND version = :read_version`. A row touched by any consumer since the snapshot has a higher version and is **skipped** (counted as `skipped_concurrent`; the next run rechecks it). This is the review's "skip rows touched during the run", made sound.
3. **New keys** (facts exist, no rollup row in the snapshot): take `pg_advisory_xact_lock(rollup_key_hash(key))`, re-check that no row exists, recompute that one key from facts **inside the same lock** (READ COMMITTED, so committed consumer facts are seen), then `INSERT ... ON CONFLICT DO NOTHING`. The consumer takes the same advisory lock before its upsert, so a consumer either committed before the recompute (its facts are counted and its row exists, so the insert does nothing) or waits and then adds its delta on top of the inserted value. No increment is lost or double-counted in any interleaving.
4. Write one reconciliation row (`checked_rows`, `mismatches`, `corrected`, `skipped_concurrent`). The comparison is facts against `value + held_value` (held increments are counted, just not published). A first run in `--backfill` mode over the whole retained range creates rollups for existing facts before any series flag is allowed. Alert: mismatches > 0 on two consecutive hourly runs tickets Platform; any mismatch in the nightly run after a clean hourly run pages (it means a consumer bug).

### Migration plan (numbers reserved for this spec; put each in `RESERVED` when the track starts, remove on merge)
| Number | Track | Content | Phase |
|---|---|---|---|
| 0088 | 6 | rollup tables with `version` and `held_value`, DEFAULT partitions plus the current and next 5 months (M2), `rollup_key_hash()`, RLS with concrete roles, grants | expand |
| 0089 | 3 | `ledger_integrity_runs`, `ledger_integrity_drift_samples`, RLS with concrete roles | expand |
| 0090 | 4, 6 | facts: covering index for union counts `CREATE INDEX CONCURRENTLY sa_facts_store_kind_shopper_idx ON seller_analytics_facts (store_id, kind, occurred_at) INCLUDE (shopper_key, source, governorate) WHERE shopper_key IS NOT NULL`; `sa_facts_occurred_idx (occurred_at)` (purge, H3); `sa_facts_shopper_idx (shopper_key) WHERE shopper_key IS NOT NULL` (erasure, H3); `term_hash` column and the relaxed search CHECK (M9); DELETE grant and column UPDATE grant with system-only policies and the erase-only trigger (H3); `seller_analytics_suppression_memo` (B2); `analytics_erased_keys` (H3). The concurrent indexes go in a separate file `0090b` if the migration linter requires one statement per concurrent build | expand (concurrent; the migration linter must allow it) |
| 0091 | 7 | `audit_log` keyset index `(occurred_at, id)` and `(chain_id, occurred_at)` (plain table, finding F4) | expand (concurrent) |
| 0092 | 1 | `devices.platform` and `auth_sessions.platform` admit `web`; `auth_sessions.uv`; `devices.install_secret_hash` (H1) | expand (constraint swap `NOT VALID` then `VALIDATE`) |
No contract migration in Phase A. Rollback: each is drop-only (no data migration); flags stay blocked until the migration is live.

Suppression memo DDL (in 0090):
```sql
CREATE TABLE seller_analytics_suppression_memo (
  store_id        uuid NOT NULL,
  metric          text NOT NULL CHECK (char_length(metric) <= 64),
  dimension       text NOT NULL CHECK (dimension IN ('none', 'source', 'governorate', 'term')),
  dim_key         text NOT NULL CHECK (char_length(dim_key) <= 64),   -- 'none' dimension uses '*'; no margin rows (ADR-0052)
  bucket          text NOT NULL CHECK (bucket ~ '^[0-9]{4}-[0-9]{2}(-[0-9]{2})?$'),  -- Cairo day (non-additive series) or month
  state           text NOT NULL CHECK (state IN ('hidden', 'released')),
  reason          text NULL CHECK (reason IN ('primary', 'complementary')),
  value           bigint NULL,                                          -- pinned released value
  CHECK ((state = 'hidden' AND reason IS NOT NULL AND value IS NULL) OR (state = 'released' AND reason IS NULL AND value IS NOT NULL)),
  first_hidden_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, metric, dimension, dim_key, bucket)
);
CREATE INDEX sasm_first_hidden_idx ON seller_analytics_suppression_memo (first_hidden_at);   -- retention purge
-- RLS: SELECT and INSERT for app_role() = 'system' only (written by releaseShopperTable under asSystemRole after the
-- seller gate); never returned on the wire except as counts; no UPDATE grant; DELETE system only (retention).
```

### Tests required
- Property: random event streams with duplicates and reordering give rollups equal to `GROUP BY` over facts; reconciliation on a deliberately corrupted row restores it.
- **Concurrency (M1), Postgres 16 in CI with two real connections** (PGlite is single-connection and cannot exercise this): a controllable interleaving harness (each side pauses at named points through advisory-lock barriers) runs every interleaving of {consumer upsert of an existing key, consumer insert of a **new** key, reconciler read phase, reconciler CAS update, reconciler new-key insert}, plus 1,000 random schedules; after every schedule rollups equal `GROUP BY` over facts, no increment is lost or doubled, and `skipped_concurrent` is counted when the CAS loses.
- Partitions (M2): the migration leaves 6 monthly partitions plus DEFAULT; an insert for an hour 7 months ahead lands in DEFAULT and the gauge reports 1; the partition job moves it and the gauge returns to 0.
- Retention and erasure (H3): rows older than 25 months are purged by the catalog target in batches using `sa_facts_occurred_idx` (EXPLAIN check); `forgetShopper` NULLs every row for keys of all epochs in the window and all key versions, leaves other users' rows untouched, and a later ingest of an old outbox payload with an erased key stores NULL; an UPDATE of any other column or to a non-NULL value is rejected by the trigger; a non-system role cannot DELETE or UPDATE; the retention coverage test fails if the catalog lacks the facts target.
- RLS: seller session for store A cannot read store B rollups (direct SQL test); seller role cannot read platform tables; an `ops` or `finance` session can read platform rollups and a `marketing` session cannot; non-system role cannot insert; no session other than system can read the suppression memo.
- Migration tests in the existing `migration.test.ts` style; migration linter green.
- Mutation targets: batch pre-aggregation, sorted-key upsert builder, reconciliation comparator.

### Rollout
Consumers behind `kill.analytics.consumers`; reconciliation is a worker job with the same capability. Series routes stay blocked until the backfill run reports `ok`. The facts purge and `forgetShopper` are **not** behind a switch: they ship enabled as soon as the facts table can receive rows (they only remove data).

---

## 7. Track 7: audit-log endpoints, attention queue, OpenAPI paths without a controller

### 7.1 Audit log list and verify
- `GET /v1/admin/audit-log?chain_id|chain_prefix&actor_id&target_type&target_id&from&to&cursor&limit` · `admin_api` · gate = policy `audit_log.read` (dpo, security, super_admin, effective roles) plus passkey · 60/60 s per user · P2.
  - At least one of `chain_id`, `chain_prefix` (>= 3 chars, e.g. `seller-analytics:`), `actor_id`, `target_id` is required, and the time window is at most 31 days (default last 24 h): 400 otherwise. Keyset cursor on `(occurred_at, id)`, limit 1-100.
  - Item: `id, occurred_at, chain_id, seq (string), actor_type, actor_id, action, target_type, target_id, diff_redacted, request_id, reason_code, hash (hex), prev_hash (hex), has_ip_hash, has_device`. `ip_hash` and `device_id` are **never** returned (no new grant; ADR-0049 lists it as an owner option).
  - Every read writes a meta-audit row (`audit_log.read`, chain `admin-audit-read:YYYY-MM`, filters with ids only) **before** returning data; failure is 503 `audit_unavailable`.
  - The list query runs under the single `app.role` that satisfied the gate (`dpo`, `security` or `super_admin`, matching policy `audit_log_read`, `0007:132-133`); `app.role` is single-valued (finding F1), so the gate picks the first held role in that order.
  - `audit_log` is a plain, unpartitioned table (finding F4); the 31-day window cap and the keyset indexes in 0091 bound each query. The retention catalog's "monthly partition detach" design for `audit_log` (`catalog.ts:80`) is not built; it is a recorded gap outside this spec.
- `GET /v1/admin/audit-log/verify?chain_id=` · same gate · 6/60 s per user · statement timeout 10 s. Runs `audit_log_verify(chain_id)`; returns `{chain_id, verified_at, rows_checked, head_seq, head_hash, checkpoints_checked, ok, problems[{seq, problem}] (<= 100), problems_truncated}`. A chain longer than 200,000 rows answers 422 `chain_too_long_use_job`; whole-database verification stays a worker job. Verification is read-only.
- Tests: shopper 401, seller 401, ops/finance/marketing/support/trust_safety 403, standing super_admin without break-glass 403, dpo/security 200; no filter 400; window 32 days 400; response never contains `ip_hash` or `device_id` (serializer test); **no known P3 field name appears anywhere inside a returned `diff_redacted`** (L4: serializer test over fixtures seeded with every P3 column name from `data_inventory.yaml`, such as `phone_e164`, `dob`, `measurements`, `iban`, `national_id`, `address`; a hit fails the test and, at runtime, the key is dropped and `outlet.audit.read.p3_key_dropped` increments); meta-audit written before body and its failure gives 503; verify on a chain with a tampered row (superuser update in a PGlite test) reports the problem; mutation target: the filter validator and serializer.
- Flag: `release.admin.audit_log`.

### 7.2 Attention queue (counts only)
- `GET /v1/admin/attention` · `admin_api` · capability `attention.read` · 30/60 s per user · P1. Response `{as_of, items[{id, group, severity, count, count_capped, oldest_at, deadline_at, href, state}]}` with `group` in `page, legal_clock, money, approvals, trust, anomaly` (benchmark section 4.2 order) and `state` in `ok, unavailable`.
- **An item is included only if the caller holds the capability the target page needs.** A missing capability omits the item (never a zero), so the response does not reveal that a queue exists. Counts are capped at 1,000.
- **Every item names one exported predicate (M7).** The visibility of each item is `capabilityPredicates[capability](access, actor, now)`, the same function `GET /v1/admin/me` uses (track 1), imported from the owning module's `index.ts`. No item may use a role list, a nav role table or an inline condition; the role-leakage snapshot test enumerates `ATTENTION_ITEMS` (an exported constant of `{id, capability}`) and fails on any item whose capability is not a key of the version-1 capability map.
- Phase A sources (all exist today; each module exposes a `count` query through its public `index.ts`):

| id | group | capability (named predicate) | source |
|---|---|---|---|
| `ledger.integrity` | page | `ledger.integrity.read` (ledger gate, standing finance plus passkey) | track 3 latest run: count 1 when failed, stale, or `audit_evidence = missing` |
| `outbox.dead_lettered` | page | `flags.read` (`ROUTE_ROLES.flagsRead`: ops, security, super_admin; ADR-0049 item 8) | `/v1/ready` outbox counters |
| `privacy.breaches_open` | legal_clock | `privacy.read` (`canReadPrivacyConsole`: dpo plus passkey) | DPO breach register, `deadline_at` = 72 h PDPC clock |
| `privacy.requests_near_sla` | legal_clock | `privacy.read` | DSAR requests older than 23 days of the 30-day default SLA |
| `kyc.suspension_reviews_overdue` | legal_clock | `kyc_review.read` (`ROUTE_ROLES.kycReviewRead`) | `isReviewOverdue` |
| `recon.tickets_aged` | money | **`recon.read`** (`canReadReconciliation` = policy `payout.read`: finance, ops; the gate of `/v1/admin/finance/reconciliation/*`, finding F5). The earlier draft said `ledger.read`, which would have hidden the item from ops who can open the page | reconciliation summary (open, escalated, aged > 3 days) |
| `payouts.on_hold_or_failed` | money | `payout.read` | payouts by state |
| `tax.rejected` | money | **`tax.read`** (new capability, `canReadTax`) | ETA documents rejected or in dead letter |
| `approvals.waiting_on_me` | approvals | `console.access` | approvals pending that the caller may approve, excluding their own requests |
| `elevations.expiring` | approvals | `console.access` | caller's elevations expiring within 10 min |
| `brand_applications.sla_late` | trust | **`brand_review.read`** (new capability, `canReadBrandReview`: ops, trust_safety with a standing grant). Reconciled with the brand queue gate (`brand-review.controller.ts:171`); the earlier "kyc read" mapping would have shown it to support, who cannot open the queue | brand review queue, SLA breached (adds a real count; today the home shows "50+") |

- **Thresholds tied to legal deadlines are owner and counsel decisions, recorded as Proposed** (section 10): DSAR "near SLA" at 23 of 30 days assumes the 30-day default SLA (VR-01 statutory deadline); breach `deadline_at` assumes the 72-hour PDPC clock runs from detection (VR-DB-01). Safe default: as stated, both values read from one config constant so the DPO can change them without code review of the queue.

- Each source runs with a 2 s timeout in parallel; a failing source gives `state: unavailable, count: null` (never 0). Non-personal sources are cached 30 s per source in process; `approvals` and `elevations` are per user and never cached. `Cache-Control: private, no-store`.
- Tests: role leakage matrix (for each role, the item id set equals a committed snapshot generated from `ATTENTION_ITEMS` and the capability predicates; finance never sees `privacy.*`; marketing sees only approvals and elevations; support never sees `brand_applications.sla_late`; ops sees `recon.tickets_aged` and `tax.rejected`); **consistency with `me`**: for random actors, the item id set equals `{item | me.capabilities[item.capability]}`; a source timeout gives `unavailable`; counts never include PII (serializer); approvals excludes self-requested. Mutation target: the capability filter.
- Flag: `release.admin.attention`. Depends on track 1 (capabilities) and track 3 (integrity source).

### 7.3 OpenAPI paths without a controller (ADR-0050)
Found by `repo_api_data.md` (moderate confidence) plus `/v1/seller/team*`, found while writing this spec. Rule from now on (M3, ADR-0050):
- **Planned operations** carry `x-status: planned`, `x-spec-ref` and **`x-planned-until`** (a phase label `phase-b`, `phase-c` or an ISO date), and must also be listed in `docs/api/planned-operations.yaml`, an allow-list owned in `CODEOWNERS` by Security and the Architect. The OpenAPI marker without the allow-list entry (or the reverse) fails CI.
- **Generated client:** a planned operation is generated as a `notImplemented` stub with the same types that never sends a request and returns `{ ok: false, error: "not_implemented" }`, so pages render an honest "not available yet" state and nothing can call a route that does not exist. Compared with dropping planned operations from the client: dropping is simpler but forces every caller to delete code and re-add it later; a stub keeps types stable and is equally safe because no network call is possible.
- **Three ratchet tests in CI:** (1) an OpenAPI operation with no Nest route and no planned marker fails; (2) **a planned operation that gains a Nest route fails** until its marker and allow-list entry are removed in the same PR; (3) **a served Nest route with no OpenAPI operation fails** (API9 shadow endpoints; the route table is read from the booted app's router, so a controller added without a contract is caught). `x-planned-until` in the past fails with a message naming the owner.

| Path | Caller today | Decision | Owner decision needed? |
|---|---|---|---|
| `GET /v1/seller/analytics/summary` | mobile Brand mode (`apps/mobile/src/features/brand-mode/api.ts:119`, 404 today, and it shares a `Promise.all` with the unserved `/v1/seller/balance`, so the Brand-mode dashboard fails as a whole, finding F8) | Add `/v1/seller/stores/{storeId}/analytics/summary` (track 4); keep the old path `deprecated` with `x-replaced-by` and `x-status: planned`. The new response has a different shape (`tiles: MetricSeries[4]` instead of `freshness_at, gmv, orders`) and window type (instants instead of Cairo dates), so it is **not** a drop-in: removing or redirecting the old path and the mobile repoint need **product sign-off** (L5) | **Yes**: product (mobile Brand-mode dashboard content) |
| `GET /v1/seller/balance` | seller-web `/finance` | **Build** as `/v1/seller/stores/{storeId}/balance` (Phase B) with available, pending, held and negative-carry totals per ADR-0021; hold *reasons* and next payout date wait for the owner | **Yes**: payout visibility (ADR-0049, extends ADR-0021) |
| `GET /v1/seller/statements` | seller-web `/finance` | **Delete**; repoint seller-web to the existing `/v1/seller/stores/{id}/statements` | No |
| `GET/POST /v1/seller/team`, `DELETE /v1/seller/team/{memberId}` | seller-web `/team` (likely 404) | **Delete**; repoint to the existing `/v1/seller/stores/{id}/team` and invite routes; move `TeamMember.role` to the policy vocabulary (track 2) | No |
| `GET /v1/admin/audit-log` | none | **Build** (7.1) | No |
| `GET /v1/admin/reconciliation/breaks` | admin-web `reconciliationBreaks` | **Delete**; repoint to `/v1/admin/finance/reconciliation/tickets` (VR-AC-03) | No |
| `GET /v1/admin/price-integrity/actions` | admin-web `priceActions` | **Keep, planned** (Phase C, read-only list over `enforcement_actions`) | No |
| `GET/PUT /v1/admin/price-integrity/config` | none | **Keep GET planned** (read-only); **PUT stays planned until the owner sets the enforcement parameters** | **Yes**: pricing and enforcement thresholds (ADR-0013, VR-07, VR-13) |
| `/v1/admin/sellers`, `/{storeId}/kyc`, `/kyc-decision` | none (admin-web uses `/v1/admin/kyc/*`) | **Delete** (superseded by the KYC routes); Entity 360 later adds `/v1/admin/sellers/{id}` with its own spec | No |
| `/v1/admin/sellers/{storeId}/suspend` | none | **Keep as planned with `x-replaced-by` until the mapping tests pass**, then delete: the superseding KYC suspension routes must be shown by HTTP tests to enforce the same roles, passkey, dual approval and the 5-business-day human review (spec 9.5, VR-15) | **Yes**: deletion is an owner decision taken on the mapping-test evidence (section 10) |
| `GET /v1/admin/order-groups/{id}` | none | **Keep, planned** (Phase C Entity 360; PII through `pii-views` reason codes) | No |
| `POST /v1/admin/disputes/{id}/resolve` | none | **Keep, planned** (Phase C; the shopper dispute route exists, the T&S human review does not). Resolution moves money through refunds, so it gets a spec plus a CR checkpoint | Not for the route; refund outcomes follow existing rules |
| `POST /v1/admin/refunds/{id}/approval`, `POST /v1/admin/payouts/{id}/approval` | none | **Keep as planned with `x-replaced-by` until the mapping tests pass**, then delete. The contract PR must include HTTP tests that the superseding routes (`/v1/admin/approvals*`, `/v1/admin/finance/payouts/{id}/approve`) enforce the **same dual-approval thresholds** as ADR-0021 (below the threshold one finance approver; at or above it a second, distinct approver; self-approval refused; the threshold read from the same constant), for refunds and payouts, including the boundary amount and threshold minus one piastre | **Yes**: deletion of these security-relevant paths is an owner decision taken on that evidence (section 10) |
| `GET /v1/admin/tax/invoices` | none | **Delete** (superseded by `/v1/admin/tax/documents`) | VAT presentation stays with tax counsel (VR-06), not affected |

Deleting a path removes it from OpenAPI and the generated client in the Wave 0 contract PR and repoints the web clients in the same PR, so no caller is left pointing at a removed operation. The three security-relevant paths (refund approval, payout approval, seller suspension) and the old summary path are **not** deleted in Wave 0; they become planned stubs with `x-replaced-by` (section 12).

---

## 8. Implementation order and parallelisation

### Shared files (conflict map)
| File | Touched by | Rule |
|---|---|---|
| `docs/api/openapi.yaml`, `packages/api-client/src/generated/*` | all tracks | **Only the Wave 0 contract PR edits them.** Later tracks change nothing in OpenAPI; if they must, they rebase on one follow-up contract PR, and run `pnpm --filter @outlet/api-client generate:check` |
| `packages/feature-flags/src/registry.ts` (and admin-web `killswitch.ts` expected list) | all tracks | Wave 0 adds every flag and switch named in this spec |
| `packages/db/migrations/*`, `RESERVED` | 1, 3, 4, 6, 7 | Numbers fixed above (0088 to 0092); each track writes its number into `RESERVED` when it starts |
| `apps/api/src/app.module.ts` | 4 (`platform-metrics`), 5 (`analytics-ingest`) | Wave 0 registers both modules as empty shells; tracks fill them |
| `apps/api/src/production/{ports,bindings,relay}.ts`, `composition/*` | 3, 5, 6 | One composition PR at the end (Wave 3); tracks ship with in-memory and Kysely adapters and module-boot tests only |
| `apps/api/src/workers/registry.ts` | 3 (recorder token), 6 (reconcile, partition jobs) | Track 3 first, then 6 rebases |
| `apps/api/src/platform/telemetry/metrics.ts` | 1, 3, 5, 6 | Each track appends its instruments in its own block; rebase conflicts are trivial; no renames |
| `docs/privacy/data_inventory.yaml` | 3, 5, 6 | Append-only entries per table; CI checks tags |
| `apps/api/src/modules/admin/domain/access.ts` | 1 (capabilities), 7 (reads them) | Track 7 starts after track 1 merges |
| `packages/policy/src/*` | 2 (permission evaluator) | Track 2 only |
| `apps/api/src/modules/seller-analytics/*` | 2 (me), 4 (series, M5, legacy gated switch), 5 (consumer mapping, terms), 6 (ingest upsert, purge, `forgetShopper`) | 2 touches only `seller-me.controller.ts`; 4 adds new files (`series.controller.ts`, `kanon-table`) and changes `application/queries.ts` and `adapters/wire.ts` (M5 first, then the flag-gated legacy switch); 5 changes `consume.ts` and `domain/ports.ts` (term rule); 6 changes `kysely-store.ts` ingest and adds `forget-shopper.ts`. Merge order 6 then 5 then 4 (M5 may merge any time) |
| `apps/admin-web/src/{api/schemas.ts, server/console.ts, view-models/nav.ts, i18n/*}` | 1, 7 | Track 1 first; i18n keys namespaced per track (`me.*`, `attention.*`, `audit.*`) |
| `apps/seller-web/src/{page-context.ts, components/Shell.tsx, view-models/nav.ts, i18n/*}` | 2 | Track 2 only |
| `tooling/e2e/gateway.mjs` | 1, 2 | Track 1 then 2 |
| `apps/api/src/modules/auth/*` (web assertion branch, install token), migration 0092 | 1 | Track 1 only (T1-a) |
| `payouts/index.ts`, `tax-eta/index.ts`, `privacy/index.ts`, `reconciliation/index.ts`, `admin/brand-review/*` (predicate exports) | 1 | Track 1 only; pure moves, no rule change |
| `apps/api/src/modules/retention/domain/catalog.ts`, privacy erasure flow (`privacy.process-deletions`) | 6 | Track 6 only (facts purge target, `forgetShopper` step, catalog text fix) |
| `docs/api/planned-operations.yaml`, `CODEOWNERS`, `.github/workflows/ci.yml` (promtool job, ratchet tests) | 0 (allow-list, ratchet), 3 (promtool) | Wave 0 adds the allow-list and the ratchet; track 3 adds the promtool job |
| `package.json` files | none | No new dependency is needed in Phase A |

### Waves
### GO and BLOCKED after the review
| Track or part | Status | What unblocks it |
|---|---|---|
| T1 admin `me` with the H1, M6, M7 changes (migration 0092, web assertion branch, server-minted install token, honest posture, HTTP-route capability tests) | **GO** | CR checkpoint (auth) before `release.admin_console.identity` is allowed in staging. Writes gated on `device_trusted` stay disabled until VR-AC-04 |
| T2 seller `me` with M8 (authorise before lookup, real store state, corrected `store_status`) | **GO** | none beyond the flag |
| T3 integrity with H4, H5 (same-transaction audit, `audit_evidence`, table-backed gauges, absence rule, CI promtool, child sample table) | **GO** | CR checkpoint (ledger read) before `release.admin.ledger_integrity`; drift-sample retention per VR-DASH-08 (safe default 25 months built) |
| T6 rollups with M1, M2 and the H3 purge and erasure | **GO** | Postgres 16 CI job for the concurrency harness (dependency) |
| T7 audit log, attention queue (M7 predicates), OpenAPI ratchet (M3) | **GO** (except the deletions below) | after T1-b and T3 |
| T4 ungated additive series (GMV, orders, units, views, impressions, funnel counts, returns, AOV, conversion), the store-scoped summary route, admin metrics | **GO** (build and allow `release.seller_analytics.series` in non-production; production data needs producers) | T6 Kysely store; producers allowed (T5) for production data |
| T4 M5 (`unique_visitors` suppressed below 50 on the legacy route) | **GO now**, no flag | none (it only reduces disclosure) |
| **T4 shopper-gated series and breakdowns, the legacy gated switch to Cairo grid plus memo plus complementary suppression (B1, B2)** | **Code GO behind the flag; release BLOCKED** | DPO decision on VR-DASH-02 and VR-DASH-05 (one decision: fold-rule replacement, Cairo alignment of gated reads, grid presets); then CR checkpoint; then `release.seller_analytics.shopper_series` |
| **T5 server producers (B3)** | **Code GO behind `kill.analytics.producers`; enabling BLOCKED** | VR-DASH-03 Verified or Accepted risk (owner and counsel), then CR checkpoint |
| **T5 client ingest for real users (H2, M4, M9)** | **Code GO behind `kill.analytics.ingest`; enabling BLOCKED** | VR-DASH-03 **and** VR-DASH-07 (Security: attestation with a server challenge) Verified or Accepted risk, then CR checkpoint |
| T5 mobile impression emission | GO (emits into the tracker; the tracker drops batches while ingest is blocked) | none |
| Deleting `/v1/admin/refunds/{id}/approval`, `/v1/admin/payouts/{id}/approval`, `/v1/admin/sellers/{storeId}/suspend` | **BLOCKED** (planned stubs meanwhile) | mapping tests green (ADR-0021 thresholds, suspension review) and the owner's decision |
| Removing `/v1/seller/analytics/summary` and repointing mobile Brand mode | **BLOCKED** | product sign-off on the new tiles and window semantics |

### Launch blockers raised by this amendment (not dashboard flags; for `docs/plan/release-checklist.md`)
1. Signed snapshot of the journal chain head and audit checkpoints (ADR-0046; needs KMS, ADR-0002 and ADR-0032). Without it, tamper evidence does not hold against a database superuser.
2. Alert delivery: Alertmanager or an on-call vendor with routes to Finance, Security and Platform (finding F7). Rules are verified but page no one until then.
3. Edge topology for admin posture: private API ingress and an edge that strips inbound posture headers and mints request ids (VR-AC-04).

### Waves
| Wave | Work | Tier | Parallel? | Depends on |
|---|---|---|---|---|
| 0 | Contract PR: every OpenAPI addition, change and deletion in section 12 (re-brief the builder with that list), `SignedMinorString`, regenerated client with planned operations as `notImplemented` stubs, `docs/api/planned-operations.yaml` and its CODEOWNERS entry, the three ratchet tests, web client repoints for deleted paths, flag registry entries (including `kill.analytics.producers` and `release.seller_analytics.shopper_series`, and removing `release.seller_analytics.breakdown_series`), empty `analytics-ingest` and `platform-metrics` modules registered in `app.module.ts`, `cairo.ts` moved to `packages/domain/src/time` | B (one builder) | no | this amendment approved |
| 1 | T1-a migration 0092, web passkey assertion branch, server-minted install token, admin-web `__Host-admin-install`, predicate exports | B + T | yes | 0 |
| 1 | T2 seller `me` extension (M8), store-scoped `me`, seller-web role nav | B + T | yes | 0 |
| 1 | T3 integrity tables, recorder (same-transaction audit), routes, table-backed gauges, rules, promtool CI job | B + T | yes | 0 |
| 1 | T6 rollup tables, consumer upsert with advisory locks, CAS reconciliation, partitions with DEFAULT, facts purge, `forgetShopper`, memo table | B + T | yes | 0 |
| 1 | T5-server producers behind `kill.analytics.producers`, ingest endpoint behind `kill.analytics.ingest` (plausibility, attestation check, uncached consent, term vocabulary) | B + T | yes | 0 |
| 1 | T5-mobile impression emission | B (mobile) | yes | 0 |
| 1 | T4-M5 legacy `unique_visitors` suppression | B + T | yes | 0 |
| 2 | T1-b `GET /v1/admin/me`, capabilities, posture, admin-web states, HTTP-route capability tests | B + T | yes | T1-a |
| 2 | T4-ungated series, summary route, admin metrics | B + T | yes | T6 (Kysely store), T5 consumer mapping |
| 2 | T4-gated: `gatedWindow`, `kanon-table` with memo, legacy gated switch, overlap and mixed-tz properties (all behind `shopper_series`) | B + T (Opus review of the property design) | yes | T6 memo table |
| 3 | T7 audit log, attention queue | B + T | yes | T1-b, T3 |
| 3 | Composition PR: bind relay routes, production ports, worker registry, readiness entries | B | no | all of Wave 1-2 |
| 3 | CR checkpoints: T1 (ACL and web sign-in), T3 (ledger read), T4-gated plus T5 (k-anonymity, consent, attestation) | CR (Fable; Opus if unavailable, say so) | no | composition PR |
| after owner and counsel | allow `shopper_series`, `kill.analytics.producers`, `kill.analytics.ingest` per the GO table | owner, DPO, Security; CR | no | VR-DASH-02, -03, -05, -07 |

Estimated effort follows the benchmark Phase A table (about 13.5 engineer-weeks for these tracks) plus about 3 engineer-weeks for this amendment (memo and overlap property, web sign-in, CAS reconciliation, erasure); re-estimate after Wave 0.

---

## 9. Acceptance (Gherkin, become tests)

- *Given* an admin with a standing `ops` grant and a live `finance` elevation, *when* the elevation expires, *then* the next `GET /v1/admin/me` omits `finance` from `roles` and the matching capabilities, and a finance route answers 403 at the same instant.
- *Given* a buyer access token, *when* it calls `GET /v1/admin/me`, *then* the response is 401 and nothing is audited as an admin read.
- *Given* the edge posture key is not configured, *when* a finance admin loads the console, *then* `ip_allowlisted` is false with source `not_configured` and every finance write control is disabled with the "IP allow-list not configured" banner.
- *Given* a valid edge posture header captured from one request, *when* it is replayed on a second request (same or different `X-Request-Id`), *then* `ip_allowlisted` is false with source `invalid`.
- *Given* an admin signed in with a passkey on admin-web, *when* `GET /v1/admin/me` is called with the matching `__Host-admin-install` token, *then* `session_binding` is `passkey_uv_browser_bound` and `device_trusted` is false with `device_source: not_configured`.
- *Given* a finance admin, *when* `capabilities["payout.approve"]` is false for that actor, *then* `POST /v1/admin/finance/payouts/{id}/approve` answers 403 for the same actor, and when it is true the route does not answer 403.
- *Given* seller A, *when* it requests `/v1/seller/stores/{B}/me`, *then* the response is 404 with the same body as an unknown store, and no store row is read.
- *Given* a seller whose store is `PAUSED`, *when* it requests its store-scoped `me`, *then* `store_status` is `paused` and `permissions` equal `decide()` for state `paused`.
- *Given* a seller with role `warehouse`, *when* seller-web renders with `release.seller_center.role_nav` allowed, *then* the nav shows exactly the items whose permission is true, and Finance is absent.
- *Given* the last completed integrity run failed, *when* a later attempt errors, *then* `GET /v1/admin/ledger/integrity` returns `state: failed` with the failed run as `latest` and the error as `latest_attempt`, and the access is audited.
- *Given* the audit insert fails while recording a completed integrity run, *then* no completed row exists, the integrity gauges keep the previous run's values, and the staleness alert fires when that run passes 26 h.
- *Given* the integrity job has not completed for 30 minutes after deploy with an empty table, *then* the absence rule `absent_over_time(outlet_ledger_integrity_ok[30m])` fires.
- *Given* a day-grain GMV series over October 2026, *then* 2026-10-29 has `hours: 25`, the sum of day points equals `totals.current`, and the previous period has 31 aligned points.
- *Given* `release.seller_analytics.shopper_series` is allowed and one source has 10 shoppers in October 2026, *when* the breakdown is requested with `preset=month:2026-10` after the settle horizon, *then* that cell is suppressed, further cells in the October column are suppressed until the hidden set covers >= 50 shoppers (or the whole column), no row total is returned, `external_total_metric` names the ungated column total, and a later request with `preset=last_full_months:3` covering October, made after a contributing shopper is erased and late facts arrive, returns every October cell with the identical value or `null` (ADR-0052).
- *Given* a gated metric, *when* it is requested with `from` and `to`, *then* the response is 400 `window_not_on_grid`; *when* it is requested with `grain=week`, *then* 400 `grain_not_allowed`.
- *Given* `release.seller_analytics.shopper_series` is blocked, *then* legacy `traffic.by_source` and `geography` keep UTC days and the fold rule, gated series ids answer 404, and legacy `unique_visitors` for a day with 49 visitors is `null` with `unique_visitors_suppressed: true`.
- *Given* `kill.analytics.producers` is blocked, *when* an order line is paid, *then* the payment transition commits and no `order_line.purchased` event exists in the outbox.
- *Given* a shopper withdraws `analytics` consent, *when* the app sends a batch 1 s later, *then* the response is 202 with `accepted: 0` and no outbox row is written.
- *Given* an analytics batch containing `budget_monthly`, *then* the request is 400 and no outbox row is written.
- *Given* a user is erased, *then* before the user row is erased no `seller_analytics_facts` row holds any of that user's pseudonyms for any epoch in the retention window.
- *Given* every outbox message is delivered twice in random order, *then* rollups equal the facts aggregation and the reconciliation job reports `ok`.
- *Given* a marketing admin, *when* it calls `GET /v1/admin/attention`, *then* the response contains no `ledger.*`, `privacy.*` or `payouts.*` item.
- *Given* an ops admin, *when* it calls `GET /v1/admin/attention`, *then* `recon.tickets_aged` and `tax.rejected` are present (ops can open both pages) and `ledger.integrity` is absent.

---

## 10. Open decisions (owner or counsel; safe default in force)

Every row is **Proposed** with a stated safe default; none is an engineering default. Rows marked (review) were added or restated by the security and privacy review.

| Decision | Who decides | Record | Safe default (built) |
|---|---|---|---|
| (review) **Writing checkout, purchase and return facts for seller reporting** (lawful basis; `governorate`, `size_label`, consented `shopper_key`) | Owner, counsel, DPO | VR-DASH-03, ADR-0045 decision 5 | Producers built behind `kill.analytics.producers`, **blocked**: nothing is written |
| (review) **Replacing the fold rule and aligning Cairo/UTC of legacy gated aggregates**, with grid presets and the monotone memo: one decision, including the finding that the fold rule already leaks across overlapping legacy requests | DPO | VR-DASH-02, VR-DASH-05, ADR-0045 decision 4, ADR-0047 | `release.seller_analytics.shopper_series` blocked; legacy unchanged (UTC, fold); no new gated surface |
| (review) **Ungated `unique_visitors`** | DPO | VR-DASH-06 | Suppressed below 50 (M5), shipped now |
| (review) **App Attest or Play Integrity on analytics ingest**, including the missing server challenge | Security | VR-DASH-07, ADR-0048 | Ingest blocked for real users; attestation required when allowed |
| (review) **Deleting `/v1/admin/refunds/{id}/approval`, `/v1/admin/payouts/{id}/approval`, `/v1/admin/sellers/{storeId}/suspend`** | Owner (Finance, Trust and Safety), on mapping-test evidence | ADR-0050, ADR-0021 | Kept as planned stubs with `x-replaced-by` |
| (review) **Replacing `/v1/seller/analytics/summary`** used by mobile Brand mode | Product | ADR-0050 | Old path kept, deprecated and planned; new store-scoped route added |
| (review) **7-year retention of `ledger_integrity_runs` with user ids** | Owner, Finance, counsel, DPO | ADR-0046 (Proposed on this point), VR-DASH-08 | Run rows (no user ids) 7 years; drift samples with user ids 25 months in a child table |
| (review) **Attention-queue thresholds tied to legal deadlines** (DSAR at 23 of 30 days; breach 72 h clock) | DPO, counsel | VR-01, VR-DB-01 | As stated, one config constant |
| (review) Attestation-free admin web sign-in (passkey with UV, origin-bound, admin-grant holders only) | Security | ADR-0048 decision 6, VR-AC-02 | Built behind `release.admin_console.identity`; CR checkpoint before staging |
| Admin posture signal sources (edge vendor attests the IP allow-list; device trust model) | Security, Infra | ADR-0048 (Proposed), VR-AC-04 | Signed edge header or false; `device_trusted` false until a posture source exists |
| Security reading the ledger integrity result; Marketing reading CAC/LTV; admin metric roles; a `store_analytics` seller resource; `ip_hash` in the audit list; who sees outbox DLQ counts; tax gate counting standing super_admin | Owner, Security | ADR-0049 (Proposed) | Integrity finance only; metrics counts ops and finance, money finance; no `store_analytics`; no `ip_hash`; DLQ ops/security/super_admin (flags readers); tax gate reported as built |
| Ledger read gate uses standing finance grants, not elevations (differs from the admin module's effective roles) | Owner, Finance | ADR-0049 note | Keep as built (stricter); `me` reports it faithfully |
| Displaying Cairo or UTC days; RTL time-axis direction; week start | Owner, Arabic UX reviewer | ADR-0047 (Proposed) | Bucket and display in Africa/Cairo with a visible "Cairo time" label; week starts Saturday (ungated only); axis direction decided by the Arabic UX reviewer after the chart spike |
| Payout visibility (hold reasons, next payout date, net payable on the seller home) | Owner, Finance, counsel | ADR-0049, extends ADR-0021, VR-DB-02 | Not shown; summary uses net after commission |
| Retention of pseudonymous facts and rollups | DPO, counsel | VR-DASH-04 | 25 months (existing `analytics_events` rule), purge built |
| Egypt DST rule stability and tz data | Platform, Infra | VR-DASH-01 | Fixtures pinned in CI; `notes: tz_rules_unverified` until Verified |
| Price-integrity config writes | Owner | ADR-0013, VR-07, VR-13 | PUT stays planned |

---

## 11. Review item map (chief-reviewer security and privacy review, 2026-10-16)

| Item | Requirement (short) | Addressed in |
|---|---|---|
| B1 | One snapping function for every shopper-gated read, same release; cross-route mixed-tz property; separate DPO flag | Section 4 "One window function for every shopper-gated read"; tests "Cross-route mixed time zones"; Rollout (`release.seller_analytics.shopper_series`); ADR-0047 decision 3; ADR-0045 |
| B2 (amended by ADR-0052: external margins, monthly one-dimensional breakdowns, pinned release ledger, settle horizon) | Persisted monotone suppression memo incl. margins; fixed calendar grid; previous period via memo; overlap property; record the existing fold leak | Section 4 "Windows" (grid presets, weeks excluded with reason), "k-anonymity: monotone suppression", "Existing weakness"; memo DDL in section 6 migration plan; tests "overlapping requests", "Memo monotonicity", "Legacy fold weakness"; VR-DASH-05; ADR-0045 |
| B3 | Producers behind `kill.analytics.producers` until VR-DASH-03; owner/counsel decision | Section 5 "Writing these facts ... is an owner and counsel decision", Rollout; section 10; ADR-0045 decision 5 |
| H1 | `device_trusted` not implementable; expand migration (`uv`, `web`), server-minted install id in `__Host-admin-install` rotated at login, honest naming, writes disabled until VR-AC-04, HTTP-route capability equality tests | Section 0.1 F2, F5; section 1 Rules (posture), "Session binding", capability table, "Capability equality is tested at the HTTP route", Tests; migration 0092; ADR-0048 |
| H2 | Ingest rate on user plus session, plausibility, attestation before real users, per-store anomaly guard | Section 5 Client ingest (rate limits, Plausibility, Attestation, Anomaly guard), Security, Tests; contract `state: held`, `notes: anomaly`; VR-DASH-07 |
| H3 | Facts are P2; catalog text wrong; 25-month purge with index or partitions; erasure across all pseudonym keys before user erasure; outbox payload in inventory | Section 0 (catalog row), 0.1 F10; section 5 "Outbox payloads are personal data"; section 6 "Facts retention and erasure (H3)"; migration 0090; tests "Retention and erasure" |
| H4 | Run row and audit row in one transaction, or `audit_evidence`; `forbid_mutation` limits; signed snapshot as launch blocker | Section 3 Flow 2 and 4 (both: one transaction **and** `audit_evidence`), Rules "Tamper evidence has limits", Failure handling, Tests; section 8 launch blockers; ADR-0046 |
| H5 | Gauges from the table on every scrape; `absent_over_time` paging rule with promtool test | Section 3 Events and metrics (table-backed observable gauges, rules, CI promtool job, alert delivery blocker), Tests; finding F7 |
| M1 | Reconciler skips rows touched during the run; advisory lock for inserted keys; two-connection property incl. new-key interleaving | Section 6 Consumer write rule, Reconciliation job (version CAS instead of `updated_at`, with the reason; advisory lock for new keys), Tests "Concurrency (M1)" |
| M2 | DEFAULT partition plus alert; first 6 months in the migration | Section 6 DDL and "DEFAULT partition alert", migration plan 0088, Tests "Partitions" |
| M3 | Planned ops as `notImplemented` stubs with `x-planned-until` and a CODEOWNERS allow-list; ratchet both ways; dual-approval mapping tests before deleting three paths; summary replacement is product sign-off | Section 7.3 rules and table; section 8 GO table; section 12; ADR-0050 |
| M4 | Consent cache invalidation or no cache; withdraw-then-batch test | Section 5 "Server consent re-check (M4)" (uncached), Tests, Acceptance |
| M5 | `unique_visitors` suppressed below 50 until the DPO answers | Section 4 "`unique_visitors` gated by default (M5)", registry, Tests, Acceptance; VR-DASH-06 |
| M6 | Edge header: `kid`, constant-time compare, edge-only reachability, edge strips inbound header, server-generated request id | Section 1 Rules (posture bullet), STRIDE, Tests, Acceptance; finding F3; ADR-0048 |
| M7 | Named exported predicate per attention item; `tax.read` added or item dropped; reconcile `recon.tickets_aged` and `brand_applications.sla_late` | Section 1 capability table (`privacy.read`, `recon.read`, `tax.read`, `brand_review.read`); section 7.2 table and "Every item names one exported predicate"; Tests; tier-1 spec A7 matrix |
| M8 | Real store state into `decide()`; lookup after authorisation; foreign equals missing in body and timing | Section 2 Flow step 2, Rules, schema (`store_status` corrected), Tests, Acceptance; finding F9 |
| M9 | Term is P2; reject name-like tokens; hash or never store terms below the release need | Section 5 "Search terms (M9)" (no name heuristic exists, finding F6; vocabulary allow-list plus `term_hash`); section 6 `term_hash`, inventory; Tests "Terms" |
| L1 | No audit on an allowed `me` | Section 1 Rules (kept, with reason) |
| L2 | Metric per outcome and deny-audit tests for `me` | Section 1 Rules and Tests "Deny audit and metrics" |
| L3 | No hash-chain details in alert payloads | Section 3 Events and metrics, Tests "Alert lint" |
| L4 | Serializer test: no P3 field name in `diff_redacted` | Section 7.1 Tests |
| L5 | Summary-path replacement needs product sign-off | Section 7.3 table; section 10; ADR-0050; finding F8 |

---

## 12. Contract deltas since the Wave 0 brief (re-brief the Wave 0 builder with this list)

The Wave 0 builder is editing `docs/api/openapi.yaml` and `packages/api-client/src/generated/*` from the pre-review text. These are the exact changes; nothing else in the contract moves.

### 12.1 Schemas and fields
| Item | Change |
|---|---|
| `AdminMe.posture` | `required` adds `session_binding`. `device_source` enum becomes `[posture_source, not_configured, dev_override]` (removes `passkey_session`, `shared_install_id`, `not_passkey`, `revoked`). New `session_binding: enum [passkey_uv_browser_bound, passkey_uv_unbound, not_passkey, revoked]`. `device_trusted` description: false in Phase A. Fix the `AdminMe` example (`device_trusted: false`, `device_source: not_configured`, add `session_binding`) |
| `AdminMe.capabilities` | `required` adds `privacy.read`, `recon.read`, `tax.read`, `brand_review.read` (all boolean); example updated; `version` stays 1 (not yet released) |
| `DeviceInfo.platform` | enum adds `web` (VR-AC-02); for `web`, `install_id` is not required and is ignored |
| Passkey assert response (`POST /v1/auth/passkey/assert` 200 body) | adds optional `install_token` (string, 43 chars base64url, present only for `platform: web`); new 403 problem `web_sign_in_not_allowed` |
| `X-Admin-Install` | new header parameter (string, 43 chars base64url) on `POST /v1/auth/refresh` and on `GET /v1/admin/me`; documented as sent by the admin-web server only |
| `SellerMembership.store_status` | enum becomes `[draft, active, paused, suspended]` |
| `MetricSeries.window` | adds `preset: string or null` with pattern `^(month:[0-9]{4}-[0-9]{2}\|last_full_months:(1\|3\|6\|12)\|current_month)$` |
| `MetricSeries.series[].points[].state` | enum adds `held` |
| `MetricSeries.suppressed` | `required` adds `memo` (integer, minimum 0) |
| `MetricSeries.notes` | enum adds `anomaly`; `maxItems` 4 to 5 |
| `MetricBreakdownSeries` | description flag name `release.seller_analytics.shopper_series` (was `breakdown_series`) |
| `LedgerIntegrityRun` | `required` adds `audit_evidence: enum [present, missing]`; `store_credit.required` adds `sample_available: boolean` |
| Legacy seller traffic response | not typed in OpenAPI today (`/v1/seller/stores/{storeId}/analytics/traffic` points at the controller Zod schema), so **no OpenAPI field change**; the controller wire gains `unique_visitors: integer or null` and `unique_visitors_suppressed: boolean` (track 4, M5) |

### 12.2 Operations
| Operation | Change |
|---|---|
| Seller series `GET /v1/seller/stores/{storeId}/analytics/series/{metricId}` | adds query `preset` (pattern above); `from` and `to` no longer `required` (required for ungated metrics, forbidden for gated ones); new 400 problems `window_not_on_grid` and (gated) `grain_not_allowed` for `week`; description: gated ids 404 while `release.seller_analytics.shopper_series` is blocked |
| Seller breakdown `.../series/{metricId}/breakdown` | query `from`/`to` replaced by required `preset`; `grain` enum `[day, month]`; flag `release.seller_analytics.shopper_series` |
| `POST /v1/analytics/events` (`ingestAnalyticsEvents`) | header parameters `X-App-Attest` (required) and `X-Client-Platform` (required, `ios` or `android`); new 401 problem `attestation_required`; rate-limit extension dimensions `user` and `session` (remove `device`); description notes plausibility rejects and the uncached consent check |
| `POST /v1/admin/refunds/{id}/approval`, `POST /v1/admin/payouts/{id}/approval`, `POST /v1/admin/sellers/{storeId}/suspend` | **do not delete in Wave 0**: mark `x-status: planned`, `x-planned-until: phase-b`, `x-replaced-by` (`/v1/admin/approvals`, `/v1/admin/finance/payouts/{id}/approve`, the KYC suspension route), `x-spec-ref` to section 7.3; generated as `notImplemented` stubs |
| `GET /v1/seller/analytics/summary` | keep: `deprecated: true`, `x-status: planned`, `x-planned-until: phase-b`, `x-replaced-by: /v1/seller/stores/{storeId}/analytics/summary` (already present at `openapi.yaml:9230`); removal waits for product sign-off |
| Other deletions in section 7.3 (`/v1/seller/statements`, `/v1/seller/team*`, `/v1/admin/reconciliation/breaks`, `/v1/admin/sellers`, `/{storeId}/kyc`, `/kyc-decision`, `/v1/admin/tax/invoices`) | unchanged: delete and repoint callers in Wave 0 |

### 12.3 Extension markers and generator
- Every `x-status: planned` operation also carries `x-planned-until` (phase label or ISO date) and `x-spec-ref`; the 17 existing planned operations get `x-planned-until` added.
- New file `docs/api/planned-operations.yaml` listing each planned `operationId`, with a `CODEOWNERS` entry (Security and Architect).
- The client generator emits planned operations as `notImplemented` stubs (same types; no request; returns `{ ok: false, error: "not_implemented" }`).
- Ratchet tests (CI): unserved without marker fails; planned with a Nest route fails; served Nest route without an OpenAPI operation fails; `x-planned-until` in the past fails.

### 12.4 Flags and switches (`packages/feature-flags/src/registry.ts`)
- **Add** `kill.analytics.producers` (allowed-when-true, default blocked; blocked: server producers append no analytics event; allow only after VR-DASH-03).
- **Add** `release.seller_analytics.shopper_series` (default blocked; owner DPO; gates every shopper-gated series and breakdown and the legacy gated switch; VR-DASH-02, VR-DASH-05).
- **Remove** `release.seller_analytics.breakdown_series` (superseded; never released).
- **Narrow** the description of `release.seller_analytics.series` to ungated series and the summary route.
- **Extend** the description of `kill.analytics.ingest`: allow for real users only after VR-DASH-03 and VR-DASH-07.
- admin-web `killswitch.ts` expected list follows these changes.

### 12.5 New problem codes
`window_not_on_grid`, `attestation_required`, `web_sign_in_not_allowed` (and `grain_not_allowed` now also for `week` on gated metrics).
