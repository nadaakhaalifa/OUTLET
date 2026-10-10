# Postgres RLS specification for tenant tables

Status: Draft for the db agent · Owner: `@outlet/policy` · Spec refs: T3, A2.10, section 0, API1/API3/API5 · Companion code: `src/decide.ts`, `src/rules.ts`, `src/db-context.ts`

RLS is the second layer. The first is the policy guard in `src/decide.ts`. A bug in one must not be exploitable alone, so every rule below is written to hold even if the guard is bypassed or misconfigured.

## Flow
1. The API resolves the actor, then the route namespace gives the audience (`/v1/...` shopper, `/v1/seller/...`, `/v1/admin/...`, courier, creator). The audience is never taken from the client.
2. `dbSessionContext(actor, audience, nowMs)` returns `{ userId, role, storeIds }` or `null`. `null` means the request must not open a transaction with any identity (RLS then sees "no identity" and returns nothing).
3. The data layer opens a transaction as `app_user` and runs `set_config(..., true)` (transaction local, PgBouncer transaction-pooling safe) for the variables below.
4. Queries run. Every tenant table carries RLS policies. A row that is not visible is indistinguishable from a row that does not exist, and the API reports it as 404.
5. The guard (`decide`) runs before the query for role, token scope, passkey, reason and dual approval. RLS does not replace that: RLS knows tenancy and identity, not sub-roles or approvals.

## Rules
### Session variables (contract, extends `0002_roles_and_helpers.sql`)
| Variable | Value | Set by | Notes |
|---|---|---|---|
| `app.user_id` | actor uuid | `dbSessionContext().userId` | empty means no identity: deny |
| `app.role` | one of `customer, seller, ops, finance, trust_safety, support, marketing, dpo, security, super_admin, courier, creator, system` | `dbSessionContext().role` | 0002 lists only `customer, seller, support, finance, dpo, security, super_admin, system`. **Open item:** add `ops, trust_safety, marketing, courier, creator` |
| `app.store_ids` | comma separated store uuids | `dbSessionContext().storeIds` | seller audience only; empty for every other audience |
| `app.device_id` | device uuid | session layer | anonymous consent and carts |
| `app.hub_id`, `app.creator_id` | uuid | **proposed new** | needed for courier and creator tenant tables |

The master prompt names `app.current_store_id` (a single store). The existing helper is `app.store_ids` (a set), which is the better contract because one login can staff several stores. The spec text should be read as "store ids". `app.role` for an expired just-in-time admin grant is never set (`dbSessionContext` returns `null`).

### Global invariants
1. `ALTER TABLE t ENABLE ROW LEVEL SECURITY` on every table that holds user or tenant data. A table with RLS enabled and no policy returns zero rows (deny by default).
2. **Add `FORCE ROW LEVEL SECURITY`** on tenant tables that the application role could ever own. The application connects only as a member of `app_user`, which owns nothing. The migrator and `SECURITY DEFINER` integrity triggers are the only bypass; this is acceptable only while both are listed in the db agent's review checklist. Never connect the API as the table owner or a superuser.
3. `REVOKE ALL ... FROM PUBLIC` then explicit `GRANT` per table and verb. Immutable tables (ledger, audit, consent) get no `UPDATE` or `DELETE` grant and a `forbid_mutation` trigger.
4. Every policy has both `USING` and, for write verbs, `WITH CHECK`, so a row cannot be moved into another tenant by an UPDATE (`WITH CHECK` repeats the tenant predicate).
5. No policy may read a client-supplied value. The only inputs are the four session variables above and column values.
6. Policies are per verb (`FOR SELECT`, `FOR INSERT`, `FOR UPDATE`, `FOR DELETE`), not `FOR ALL`, on tenant tables, so SELECT can be wider than write.
7. A soft-deleted row (`deleted_at IS NOT NULL`) is hidden from the app roles by the `SELECT` policy. Only `system` and the role named in the restore rule may see it (matches `allowDeleted`, which no default rule sets).
8. Helper functions used inside policies are `STABLE`, `SECURITY INVOKER` and read only session variables. A `SECURITY DEFINER` helper that reads another RLS table is forbidden in a policy (it bypasses that table's policy).
9. An RLS policy that references another table (for example `EXISTS (SELECT 1 FROM postings ...)`) must be reviewed for the policy of that table and for the cost of the sub-select. Prefer denormalising `store_id` or `owner_id` onto the child (already done for `products.store_id`).

### Table classes and required policies
Let `uid = app_user_id()`, `role = app_role()`, `stores = app_store_ids()`.

| Class | Tables (current or planned) | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|---|
| **A. User-owned** | `users`, `identities`, `devices`, `sessions`, `session_families`, `addresses`, `carts`, `cart_items`, `wishlists`, `orders` (buyer side), `return_requests`, `reviews`, `store_credit_accounts`, `gift_cards` (holder side), `dsar_exports` | `user_id = uid` OR `role = 'system'` | `user_id = uid` (WITH CHECK) OR `system` | `user_id = uid` in both USING and WITH CHECK, so `user_id` cannot be reassigned | `user_id = uid` only where the data model allows deletion; otherwise no grant |
| **B. Store-tenant** | `products`, `product_variants`, `store_inventory`, `store_orders` (seller view), `store_returns`, `store_payouts`, `store_settings`, `store_staff`, `listings` | `store_id = ANY(stores)` (cast text/uuid consistently) OR public-read predicate for ACTIVE catalogue rows (see below) OR platform role in the allow list | `store_id = ANY(stores)` in WITH CHECK | `store_id = ANY(stores)` in USING **and** WITH CHECK | `store_id = ANY(stores)` where deletion is allowed; soft delete preferred |
| **C. Platform-only** | `outbox_events`, `inbox_processed`, `audit_log` (append), `audit_chain_checkpoints`, `feature_flags` | by the role allow list below | by the role allow list | by the role allow list | none |
| **D. Ledger** | `ledger_accounts`, `journal_entries`, `postings` | owner match (`owner_type='store'` and `owner_id = ANY(stores)`, or `owner_type='user'` and `owner_id = uid::text`) OR `finance`, `super_admin`, `system` | `finance`, `system` only | `ledger_accounts` only (close), by `finance`, `system`; never on entries or postings | none |
| **E. Courier and creator** | `courier_tasks`, `creator_links`, `creator_payouts` | `hub_id = app_hub_id()` / `creator_id = app_creator_id()` OR `ops`/`finance` | owner match | owner match in USING and WITH CHECK | none |

Public-read predicate for catalogue: `status = 'ACTIVE' AND deleted_at IS NULL`, `FOR SELECT` only, and only the columns granted to `app_user` through a view if any column is seller-private (cost, supplier price). Public read never applies to `store_orders`, `store_payouts` or inventory.

### Platform role allow lists (SELECT unless stated)
| Role | May read (beyond own data) | Notes |
|---|---|---|
| `ops` | catalogue and order metadata, feature flags (write) | no PII columns |
| `finance` | ledger, payouts, refunds | write via ledger functions only; dual approval is enforced by the guard, not RLS |
| `support` | users, orders | **Gap:** 0007 lets `support` read all `users` rows with no reason code. The guard requires a `reason` for `pii_view`; RLS cannot see it. Either move PII behind a `SECURITY DEFINER` function that writes an `audit_log` row with the reason, or restrict `users` SELECT for `support` to a column-limited view |
| `trust_safety` | users (limited columns), reviews, listings flags | |
| `marketing` | no PII; aggregates only | |
| `dpo` | `consent_records`, `audit_log`, DSAR tables | |
| `security` | `audit_log`, checkpoints | |
| `super_admin` | break-glass only | the guard requires dual approval and a reason; log every session start in `audit_log`. RLS cannot enforce approval, so a `super_admin` DB session must be opened only by the break-glass use case |
| `system` | everything the workers need | used only by the outbox relay and jobs, never by a user request |

### Consistency with the guard
The guard and RLS must agree on tenancy. `src/rules.ts` is the reference: every rule with `scope: "owner"` maps to a class A table, `"store"` to class B, `"hub"`/`"creator"` to class E, `"platform"` to the role allow lists. A pull request that changes one must change the other. The db agent should add a CI check that every table in `docs/data-model/*` with an owner or `store_id` column has RLS enabled and at least one policy.

## Edge cases
- **Cross-tenant joins.** A seller query that joins `orders` to `store_orders` must not reveal buyer PII: `orders` has no seller policy. Expose a seller-safe view (`store_orders` with shipping name and city only, as the data model allows).
- **Aggregates and counts.** `count(*)` under RLS only counts visible rows. Admin dashboards read from the warehouse semantic layer (A2.8), which applies its own store RLS.
- **Triggers and constraints.** Unique and foreign-key checks run as the owner and can leak existence through error messages (for example a duplicate SKU in another store). Scope uniqueness by `(store_id, sku)`, and map unique violations on tenant tables to a generic 409 without echoing values.
- **Multi-store staff.** `app.store_ids` holds all stores the actor staffs. A route that targets one store must also assert the path store is in the set (guard), which gives a 404 before the query.
- **Role downgrade or suspension mid-request.** Session variables are transaction local and re-derived per request, so a suspended actor loses access on the next request. Refresh tokens are revoked by the auth module.
- **Table owner and migrations.** Migrations run as the owner and bypass RLS. Backfills that touch many tenants must set no `app.*` variables and be reviewed separately.
- **Read replicas and analytics.** Replicas inherit policies. Any role that reads through a replica uses the same `app_user` membership.

## Data
Session variables above; no new tables. Optional helpers `app_hub_id()` and `app_creator_id()` mirroring `app_user_id()`. Policy naming: `<table>_<audience>_<verb>`, for example `store_orders_seller_select`.

## API
None directly. The only API contract is `dbSessionContext` in `src/db-context.ts`, which returns the three values to set. The data layer must call it once per request and must not set variables from any other source.

## Events
Every denied write that reaches the database (RLS violation, SQLSTATE `42501`) is a signal that the guard missed a case: emit `authz.rls_violation` (actor id, table, verb, route) to the security log and alert. The guard's own denials are audited from `Decision.audit`.

## Failure handling
- RLS violation on write: return 404 for a tenant object, 403 otherwise, never the SQL message. Log internally.
- Missing session variable: the query returns no rows or fails the `WITH CHECK`. The data layer must treat "no context was set" as a programming error and fail the request with 500, not as an empty list.
- Fail closed: if `dbSessionContext` returns `null` the request does not open a database identity at all.

## Security and abuse
- Enumeration: UUIDv7 ids are not secret; do not rely on id secrecy. 404 for not-owned equals 404 for not-found, with identical bodies and similar latency.
- Timing: avoid an early return that makes "exists but not yours" measurably faster than "does not exist"; run the same single query.
- Privilege escalation through `SET ROLE` or `set_config('app.role', ...)`: the application SQL layer must never accept raw SQL from callers; the session role must not be able to `SET ROLE` to a bypass role (revoke membership).
- `search_path` hijack: pin `search_path` on every `SECURITY DEFINER` function.

## Metrics
- Count of `authz.rls_violation` events (target zero in production; any non-zero is an incident for review).
- Count of guard denials by `reason` (from `Decision.audit.reason`), alerting on a spike in `not_owned` per actor (enumeration probe).
- Percentage of tenant tables with RLS enabled and at least one policy (target 100%, CI-checked).

## Acceptance
1. For every class A and B table, an integration test connects as `app_user` with context for tenant X and asserts that rows of tenant Y are neither selectable, updatable, deletable nor insertable, and that an UPDATE cannot move a row to tenant Y.
2. With no `app.*` variable set, every tenant table returns zero rows and rejects writes.
3. With `app.role = 'customer'` and a seller's store id in `app.store_ids`, class B tables return nothing (role must come from `dbSessionContext`, which never produces that combination; the test documents that RLS keys on both).
4. The matrix in `src/matrix.test.ts` is mirrored at database level for at least orders, store products, store payouts and ledger accounts.
5. Immutable tables reject UPDATE and DELETE for every `app_user` context including `super_admin`.

## VERIFY BEFORE LAUNCH
- Whether `support` and `trust_safety` staff may read user rows at all in Phase 1, and under which legal basis (PDPL). No real personal data may be processed until ADR-0002 is accepted.
- Dual approval thresholds for refunds and payouts (`DefaultRuleConfig`) are owner decisions; none is assumed.
- Data residency and which DB hosts apply policies (ADR-0002, open questions) is outside this document.

## Reconciliation items for `0007_rls_and_grants.sql`
The header of 0007 states it predates this document. Differences to resolve: (1) roles `ops`, `trust_safety`, `marketing`, `courier`, `creator` are missing from the `app.role` list; (2) `users_self_select` gives `support` unconditional read (see Support row); (3) `FORCE ROW LEVEL SECURITY` is not set; (4) tenant tables from the catalogue, orders and inventory modules are not covered yet; (5) `journal_entries_select` uses an `EXISTS` on `postings`, which itself depends on `ledger_accounts` policy, so costs and correctness need a test.
