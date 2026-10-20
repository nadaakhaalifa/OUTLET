# Infrastructure as code

See `infra/terraform/README.md` for the module list and usage, and ADR-0016 for the layout
decision. This note records scope and honest status.

## Status

* Terraform skeleton with nine modules and `dev`, `staging`, `prod` environments, plus Conftest
  guardrails. **Not validated**: no `terraform`, `conftest` or `opa` binary was available, so
  `fmt`, `validate`, `plan` and the Rego policies have never been run. Expect small syntax or
  provider-argument corrections on the first CI run (the `iac` job in `ci.yml` is where they will
  show up).
* Nothing was applied. There is no cloud account, no state bucket, no registry.

## Decisions deferred to ADR-0002

Provider and region. Variables carry them; modules assume AWS shapes. Switching provider keeps the
module interface (inputs and outputs) and replaces internals.

## Environment rules (T7, T5)

* dev: synthetic data only, single NAT, single-AZ data stores, force-destroy buckets.
* staging: prod-like topology, synthetic data only, separate account or at minimum separate state,
  roles and KMS keys. It must not be able to read production data or secrets (API9).
* prod: three AZs, multi-AZ Postgres, Redis with failover, 35-day PITR, deletion protection.
  Do not apply until ADR-0002 is Accepted.
* Each environment trusts only its own GitHub Environment subject over OIDC; no static cloud keys.

## Open items

Compute service and task definitions, load balancer, autoscaling on queue depth and RPS with
scheduled pre-scaling for drops, blue/green and canary (5, 25, 100 percent with SLO gates),
waiting room, alarms and dashboards, backup restore drills (T9), a bootstrap stack for the state
backend, per-environment AWS account structure and break-glass accounts. None are started.
Instance sizes in the environments are placeholders for sizing work, not capacity-planned values.
