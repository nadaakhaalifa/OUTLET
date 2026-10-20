# OpenAPI drift ratchet

`openapi-drift.test.ts` checks that every `path + method` in `docs/api/openapi.yaml` is served by a NestJS
controller under `apps/api/src` (global prefix `v1`, params normalised so `{id}` equals `:id`).
Known gaps live in `unserved-baseline.json`. An operation may also be declared before its controller exists by
carrying `x-status: planned` and a non-empty `x-spec-ref` (ADR-0050); planned operations are not counted as
unserved. The test fails when:

- a NEW unserved operation appears (fix the controller or the spec), or
- a baselined operation is now served (or left the spec, or is now marked planned) and the baseline was not shrunk, or
- an operation has an `x-status` other than `planned`, or `planned` without an `x-spec-ref`.

The ratchet (ADR-0050, spec dashboard-foundations 12.3) also fails when:

- a planned operation now has a Nest route (remove `x-status` and its `docs/api/planned-operations.yaml` entry in the same PR),
- a Nest route is served with no OpenAPI operation (API9 shadow endpoint). Only `GET /v1/health` and `GET /v1/ready`
  are allow-listed, in `SHADOW_ALLOW_LIST` in `extract.ts`; do not extend it, add the contract operation,
- `x-planned-until` is missing, malformed, or an ISO date in the past (phase labels such as `phase-b` always pass;
  dates are compared with an injectable clock, `OPENAPI_DRIFT_NOW` in tests),
- `docs/api/planned-operations.yaml` and the OpenAPI `x-status: planned` set differ in either direction, or the
  `operation_id` / `planned_until` values disagree. The file is owned in CODEOWNERS by Security and the Architect.

The generated client emits planned operations as `notImplemented` stubs (`planned: true`; no request is sent;
the call returns `{ ok: false, error: "not_implemented" }`).

## Updating the baseline
- Shrinking: delete the listed lines (the failure message names them). Always allowed.
- Growing: do not. Only with a recorded reason (ADR or PR note) and counsel of the owner; prefer implementing
  the controller or removing the operation from the spec.
- Keep the file sorted and unique (enforced). Keys look like `POST /v1/admin/sellers/{}/approve`.

Reconcile with `docs/plan/openapi-uncontrolled-paths.md` when that list lands.

## Limitations
Static regex extraction: only literal string arguments to `@Controller(...)` and `@Get/@Post/...`.
Object-form `@Controller({ path })`, constants, `@All`, routes registered via `app.get(...)`, RouterModule
or non-test files outside `src` are not seen. Test files are skipped.

Negative proof: run with `OPENAPI_DRIFT_SPEC=/path/to/modified-copy.yaml`.

## Wave 0 of the dashboard foundations (2026-10-16)
Baseline 42 to 25 entries. Removed: 12 deleted operations (`/v1/seller/team*`, `/v1/seller/statements`,
`/v1/admin/reconciliation/breaks`, `/v1/admin/sellers*`, `/v1/admin/refunds/{}/approval`,
`/v1/admin/payouts/{}/approval`, `/v1/admin/tax/invoices`) and 5 now `planned` (`GET /v1/admin/order-groups/{}`,
`POST /v1/admin/disputes/{}/resolve`, `GET /v1/admin/price-integrity/actions`, `GET` and `PUT`
`/v1/admin/price-integrity/config`). Nothing was added to the baseline: the operations new in Wave 0 are `planned`.
Still baselined (build items or undecided, see docs/plan/openapi-uncontrolled-paths.md): the rest of the list,
including the two `deprecated` operations (`/v1/seller/analytics/summary`, `/v1/seller/balance`).

## Wave 0b (2026-10-16, post-review contract deltas)
Baseline 25 to 24: `GET /v1/seller/analytics/summary` is now `deprecated` and `planned` (`x-replaced-by`), so it left
the baseline. Nothing was added. Removed from the contract as planned the same day: `GET /v1/seller/stores/{storeId}/me`
(its controller landed, so the planned marker and allow-list entry were dropped).
