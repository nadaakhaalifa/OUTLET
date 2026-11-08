# ADR-0011: Database roles and RLS contexts (request, pre-auth, worker)

- Status: **Proposed** (technical; no owner-decision dependency). Chief-reviewer checkpoint required before the migration lands (auth + personal data).
- Date: 2026-11-08
- Deciders: CTO, tech lead, security
- Sources: `docs/BUILD-PROMPT.md` §3 (PgBouncer transaction mode, pools per process), §4 (non-owner role, FORCE RLS, `SET LOCAL` per tx); `docs/data-model.md` §2.5, §7.5; migrations 0002, 0003, 0006; `packages/db/src/{tenant,rls-audit}.ts`; `infra/local/postgres/init/001-roles.sql`; `packages/auth-core/src/{otp,session,devices,purge}.ts`; `packages/privacy/src/{deletion,retention}.ts`; `packages/outbox/src/relay.ts`

## Context

- 0006 forces RLS on `users`, `user_identities`, `devices`, `session_families`, `age_attestations` and every user-keyed table from 0004. An unset context reads as NULL, so **no row matches** (fail closed). Good for the request path, but three kinds of code now cannot run as `outlet_app`:
  1. **Pre-auth** (no user yet): `registerDevice` inserts `devices` with `user_id NULL` and upserts on `install_id_hash`; OTP verify looks up `users` by `(market_id, phone_bidx)`, then inserts `users`/`age_attestations`/`age_blocks`; `SessionService.rotate` finds a refresh token by hash and joins `session_families` before any user is known; `create` binds a device to the new user.
  2. **Cross-user workers**: `DeletionService.execute` scans `privacy_requests` across users; `runRetention` and `purge.ts` delete old rows across users; the outbox relay reads all unpublished events.
  3. Today `otp_challenges`, `refresh_tokens`, `age_blocks`, `rate_limit_hits`, `outbox_events` have **no RLS and are readable by `outlet_app`** through the default grants in `001-roles.sql`. That is a gap, not a design.
- `docs/data-model.md` §2.5 already names an `app_worker` role "with narrow policies per job, never BYPASSRLS" and an `app_admin` role. This ADR makes that concrete.

## Options considered

| Option | Complexity | Correctness / security | Cost | Scalability |
|---|---|---|---|---|
| **A. Dedicated least-privilege roles + role-scoped policies keyed on `app.ctx` (chosen)** | Medium: 4 roles, ~15 extra policies, typed TS contexts | Every exception is a policy `TO <role>` that also needs the right `app.ctx`; a bug in the request path cannot reach it. Audit and tests can enumerate it | Two more PgBouncer pools (~10 connections) | Pools isolate auth spikes and workers from checkout |
| A2. Worker role with `BYPASSRLS`, narrowed by table grants | Low | BYPASSRLS is all rows of every granted table; deletion needs `users`, so it sees every user. Violates §2.5 | Low | Same |
| B. `SECURITY DEFINER` functions for pre-auth/worker ops | Medium-high | FORCE RLS binds the owner too, so the definer must be a BYPASSRLS role. Logic moves into plpgsql outside Zod, mutation tests and the domain layer; `search_path` hijack risk; each new path is a migration | Low | Fine |
| C. Policies allowing INSERT (or reads) when the user context is NULL | Low | Applies to every role, so a request-path bug with a missing context **creates rows**. Turns "unset = nothing" into "unset = something". Solves no lookup-by-hash or worker case | Low | Fine |

**Choice (2–3 lines):** A is the only option that keeps "unset context = no rows" for the request path while giving each exception a named role, a named context and a reviewable policy. A2 and B both need a BYPASSRLS principal; C weakens the default for everyone. The cost is a few policies and two small pools.

## Decision

### Roles (cluster-level; created by infra/IaC, never by migrations)

| Role | Used by | RLS | Notes |
|---|---|---|---|
| `outlet_migrator` | Migrations only, direct connection, never pooled | owner | Owns all objects; FORCE RLS binds it too |
| `outlet_app` | API request path | enforced | Default grants as today, minus the auth-only and worker-only tables below |
| `outlet_auth` | Pre-auth endpoints in the API (`/v1/auth/*`) | enforced | Explicit grants only; no default privileges |
| `outlet_worker` | BullMQ/cron workers, outbox relay | enforced | Explicit grants only |
| `outlet_admin` | Admin Console (later ADR; reason-code policies) | enforced | Reserved name now |

All: `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOINHERIT`, no membership in any other role. Separate credentials; the worker process never holds `outlet_app`/`outlet_auth` credentials.

### `SET LOCAL` contract (one call per transaction via `set_config(k, v, true)`)

| Setting | Values | Read by |
|---|---|---|
| `app.ctx` | `user` · `store` · `auth` · `worker` | `app.ctx()`; every non-isolation policy |
| `app.job` | worker job id: `outbox.relay`, `privacy.deletion`, `privacy.retention`, `auth.purge` | `app.job()`; worker policies |
| `app.current_market_id` | ISO market, **always set** | all policies |
| `app.current_user_id` | uuid or `''` | `_user_isolation` policies |
| `app.current_store_id` | uuid or `''` (`store` ctx also sets the acting staff user) | `_store_isolation` policies |
| `app.auth_phone_bidx`, `app.auth_install_hash`, `app.auth_token_hash` | hex, `auth` ctx only | auth policies (exact-match binding) |
| `app.auth_device_id` | uuid, `auth` ctx only | auth policies |

`packages/db` replaces `withTenant` with `withDbContext(client, ctx)` where `ctx` is a discriminated union (Zod-validated) and `client` is branded by role (`SqlClient<"app" | "auth" | "worker">`), so `{ kind: "worker" }` on an app client is a compile error. Every setting is written every time (unset = `''`), so nothing is inherited. `withTenant` stays as a thin wrapper for `user`/`store`.

### Policies
- `_user_isolation` / `_store_isolation` stay `TO PUBLIC`: they apply to every role. Once a pre-auth or worker transaction knows the user, it **sets `app.current_user_id` and continues under the normal user policy** ("narrow, then act").
- Every exception policy is `TO <one role>`, named `<tbl>__auth_<purpose>` or `<tbl>__worker_<job>`, and its qual starts with `app.ctx() = '…' AND app.current_market_id() = market_id` (where the table has `market_id`), plus `app.job() = '…'` for workers. Pre-auth exceptions:
  - `users` (SELECT, column grant `id, market_id, status, phone_bidx` only): `phone_bidx = app.auth_phone_bidx()`. INSERT: `WITH CHECK market pin`; the tx then sets `current_user_id` to the new id.
  - `devices`: INSERT `WITH CHECK (user_id IS NULL)`; SELECT/UPDATE `USING (id = app.auth_device_id() OR install_id_hash = app.auth_install_hash())` `WITH CHECK (user_id IS NULL OR user_id = app.current_user_id())`.
  - `session_families` SELECT: `id IN (SELECT family_id FROM refresh_tokens WHERE token_hash = app.auth_token_hash())`; then `current_user_id := family.user_id`.
  - `otp_challenges`, `age_blocks`, `rate_limit_hits`, `refresh_tokens`: RLS enabled + forced, market pin where the column exists; granted to `outlet_auth` (and `outlet_worker` for purge) only; **revoked from `outlet_app`**.
- Worker exceptions: `privacy_requests__worker_privacy_deletion` (SELECT, queue columns); retention policies **generated per `retention_policies` row** as SELECT+DELETE `USING (app.job() = 'privacy.retention' AND <ts_col> < now() - <retain_for>)`, so the database itself refuses to delete rows younger than the cutoff.

### PgBouncer pools (transaction mode; each alias pins `user=`)

| Alias | Server role | `application_name` | Size (local) |
|---|---|---|---|
| `outlet_catalog` | `outlet_app` | `catalog.read` (+ general API) | 20 |
| `outlet_checkout` | `outlet_app` | `checkout.reserve` (`SET LOCAL statement_timeout='2s'`) | 10 + 5 reserve |
| `outlet_auth` | `outlet_auth` | `auth` | 5 |
| `outlet_worker` | `outlet_worker` | `worker.<job>` | 5 |

Worst case 45 server connections per PgBouncer; production rule unchanged (pools × size × instances < `max_connections`). No `SET ROLE` through the pooler, ever: role = pool.

### `assertRuntimeRole(db, expected)` (replaces `assertNotBypassingRls` at boot, per pool)
Fails unless: `current_user = expected`; `rolsuper`, `rolbypassrls`, `rolcreaterole` all false; not a member of any role (`pg_auth_members` empty both ways); owns no relation in non-system schemas. Per role: `outlet_app` has **no** privilege on `otp_challenges`, `refresh_tokens`, `age_blocks`, `rate_limit_hits` and only INSERT on `outbox_events`; `outlet_auth` has INSERT only on `outbox_events` (ctx `auth`, market-pinned, for `user.registered`) and no SELECT/UPDATE/DELETE on it, and no privilege on `privacy_requests` or store tables; `outlet_worker` has no INSERT on `users`/`devices`/`session_families`.

### RLS audit changes (`rls-audit.ts`)
Keeps the isolation-policy checks and adds: (1) every policy other than `_user_isolation`/`_store_isolation` must have `polroles` = exactly one named role (never PUBLIC), follow the naming rule, and have a qual containing `app.ctx()`; worker ones also `app.job()`. (2) No policy qual equal to `true` or missing a market pin when `market_id` exists. (3) Every `retention_policies` row whose table exists has its generated worker policy. (4) The full exception list (`table, policy, role, cmd`) is emitted and **snapshot-tested** (`packages/db/test/__snapshots__/rls-exceptions.snap`) with CODEOWNERS = security, so any new cross-user path is a reviewed diff.

### Migration and test plan
1. `infra/local/postgres/init/001-roles.sql`: add `outlet_auth`, `outlet_worker`, `outlet_admin`; default privileges keep granting only `outlet_app`. IaC mirrors it per cell.
2. **Migration `0007_db_roles_and_contexts.sql`** (expand): assert the roles exist (RAISE if not); add `app.ctx()`, `app.job()`, `app.auth_*()` helpers (NULL-safe like 0002); `REVOKE` the auth/worker tables from `outlet_app`, `REVOKE SELECT, UPDATE, DELETE ON outbox_events FROM outlet_app`; explicit grants; enable + force RLS on the four auth tables; create the exception policies; `app.enable_retention_policy(code)` helper and calls for existing rows. Later migrations that add a retention row or an auth/worker table call the helpers in the same file.
3. `packages/db/src/testing.ts`: bootstrap SQL creates the same roles `NOLOGIN` before `applyMigrations`. Tests use `SET LOCAL ROLE outlet_<x>` inside the transaction (PGlite is superuser). Replace the ad-hoc `app_user` in `rls.test.ts` and `consent.test.ts` with `outlet_app`.
4. Required PGlite tests: a role × ctx × table × command matrix (expected allow/deny table checked in); `outlet_app` with `app.ctx='auth'` sees no user by phone (policy is role-scoped); `outlet_auth` without `auth_phone_bidx` sees 0 users and cannot read a second user's columns beyond the grant; a device bound to user A cannot be set to user B in `user` ctx; `outlet_worker` with `job='outbox.relay'` reads no `users`; the retention policy refuses a row one second younger than the cutoff even with `WHERE true`; settings are empty after commit.
5. Real-Postgres CI job (docker compose, through PgBouncer): two interleaved clients on one pool prove no context leak; `assertRuntimeRole` passes for each pool and fails for `outlet_migrator`.

## Consequences
- **auth-core**: `OtpService`, `registerDevice`, `SessionService.create/rotate` take an auth-branded client and run in `withDbContext({ kind: "auth", marketId, auth: {...} })`, switching to user context once the user is known. `logout` and `listSessions` run as `outlet_app` in `user` ctx. `purge.ts` moves to the worker (`auth.purge`).
- **privacy**: `DeletionService.execute` scans the queue in `worker`/`privacy.deletion` ctx, then runs each request in its own tx with `current_user_id` set, so the pseudonymiser works under the normal user policies (and the "both" policies on order tables). Request creation, export and consent stay on `outlet_app` in `user` ctx. `runRetention` runs in `worker`/`privacy.retention`; the DB enforces the cutoff, so a bad `retain_for` read in TS cannot over-delete.
- **outbox**: writers keep INSERT on `outbox_events` as `outlet_app`; only `outlet_worker` (`outbox.relay`) can SELECT/UPDATE it and INSERT `dlq_messages`; consumers write `inbox_processed` as `outlet_worker`.
- The API process holds two credentials (app, auth). Splitting auth into its own service later needs no schema change.
- A shopper signing in on a device bound to another user: the auth tx may rebind it (policy allows), and must revoke the other user's families on that device; builder adds a `session_families__auth_device_rebind` UPDATE policy limited to `revoked_at`/`revoke_reason`.
- Cost: ~10 extra pooled connections per PgBouncer; one more snapshot to keep green.

## Verify-register rows
None new. Managed-Postgres support for custom roles, `NOBYPASSRLS` and PgBouncer per cell is covered by **V37** (Huawei Cloud Cairo service catalog).

## Related
ADR-0001 (modular monolith, pools), ADR-0002 (cells), ADR-0006 (`market_id` everywhere), `docs/data-model.md` §2.5, §7.5; chief-review findings H1, M8 (0006).

## Decision log

- **2026-11-08:** `outlet_auth` gets INSERT-only on `outbox_events` (policy `outbox_events__auth_emit`, ctx `auth`, market-pinned) so auth-core can emit `user.registered` at OTP verify. Implementation deviations already made in migration 0007, recorded here for review:
  - `outbox_events` and `dlq_messages` have FORCE RLS; `outbox_events` carries `outbox_events__app_insert` (outlet_app), `outbox_events__auth_emit` (outlet_auth) and `outbox_events__worker_emit` (outlet_worker).
  - `consent_records__auth_visitor`: outlet_auth INSERT for visitor consent (`user_id IS NULL`).
  - `session_families__auth_device_rebind_select` is added beside `session_families__auth_device_rebind`, so the rebind UPDATE can read the device's families.
  - Worker grants are narrow-then-act: the worker first selects the queue or the purge set, then acts on rows through the job-scoped policies.
  - One retention policy per table.

- **2026-11-08 (chief-reviewer round 1, B/A findings):**
  - `contextClient(client, ctx)` (production twin of the test-only `roleClient`) and `narrowContext(tx, {userId})` live in `@outlet/db`. auth-core builds one auth context per request (market pin plus phone / device / token keys) and narrows to the user as soon as the user row is found or created. `withDbContext`'s unbranded overload rejects role-branded clients (`UnbrandedSqlClient`), so the `ContextFor<R>` check cannot be bypassed.
  - New context key `app.auth_device_hash` (`AuthKeys.deviceHash`): `age_blocks__auth_device` matches `HMAC(device, deviceId)`, which is what OtpService stores; the install hash stays for `devices`.
  - New policy `session_families__auth_revoke_by_token` (UPDATE): a real token presented from the wrong device still revokes its family. `refresh_tokens__auth_issue` WITH CHECK now requires the family to be visible to the context (no planting tokens in another device's family).
  - `outlet_auth` gets DELETE on `otp_challenges` (kept DELETE rather than an UPDATE of a consumed column: no such column exists and the failed-SMS rollback is pinned by a test) and SELECT on `users.phone_verified_at`.
  - `registerDevice` is `INSERT ... ON CONFLICT (install_id_hash) DO NOTHING` plus a lookup-policy SELECT; the user binding and `last_seen_at` are written by `SessionService.issue` in the narrowed user context.
  - `user_identities`: `outlet_auth` keeps SELECT/INSERT/UPDATE for the future Apple/Google/passkey login; auth-core does not touch it yet, and the table is user-isolated, so it is reachable only after `narrowContext`.
  - The outbox relay must run PER MARKET (one worker context per market): relay policies pin `app.current_market_id()`.
  - `assertRuntimeRole(outlet_app)` now also denies UPDATE/DELETE on `postings` and `journal_entries` (ledger is append-only).

## Revisit when
The admin console needs DB access (`outlet_admin` reason-code policies, own ADR), or a worker needs cross-user access to a table not listed here (new policy + snapshot diff + security review).
