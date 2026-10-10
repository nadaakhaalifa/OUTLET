# Infrastructure as code

Status: skeleton, **not validated** (no `terraform` binary on the authoring machine; `fmt` and
`validate` run in CI, see the `iac` job). Nothing here has been applied, and no cloud account
exists yet. See ADR-0016 for the layout and ADR-0002 for the open residency decision.

```
modules/
  network/         VPC, public and private subnets, NAT, default-deny SG
  kms/             one rotating CMK per purpose (data, pii, logs, secrets)
  postgres/        encrypted private Postgres, PITR, managed master credential
  redis/           encrypted Redis replication group
  object-storage/  private versioned KMS-encrypted buckets, optional WORM (audit)
  cdn-waf/         CloudFront + WAFv2 (managed rules, rate limit)
  compute/         ECS cluster, log group, IAM roles (no service yet)
  secrets/         secret containers only, values set out of band
  github-oidc/     keyless CI role, subject-scoped
environments/
  dev/ staging/ prod/   thin compositions; region is a required variable with no default
policy/            Conftest (OPA) guardrails
```

## Provider and region are pending ADR-0002

* `var.region` has **no default**. It is decided by the data-residency ADR.
* The modules are written against AWS as a working assumption (T7 mentions ECS). `var.cloud_provider`
  is validated to `aws`, so a different choice fails fast instead of producing a mixed stack.
* **VERIFY BEFORE LAUNCH**: whether the chosen region offers every service used here (WAF, managed
  Postgres, KMS, object lock). If PDPL residency requires in-country hosting and no hyperscaler
  region qualifies, these module internals change; the interfaces and the environment layout stay.

## Use

```sh
cd infra/terraform/environments/dev
cp backend.hcl.example backend.hcl        # fill in, do not commit
terraform init -backend-config=backend.hcl
terraform plan -var region=<from ADR-0002> -var github_repository=<owner/repo>
```

## Known gaps (also in docs/engineering/iac.md)

* No ECS service or task definition, load balancer, or autoscaling: they need a signed image and a
  decision on the orchestrator.
* No waiting-room/queue product, no blue/green or canary wiring, no scheduled pre-scaling.
* CloudFront origin access control for the S3 origin needs a bucket policy statement once the real
  origin is chosen.
* Redis AUTH/ACL user group is not configured (transit encryption only).
* No monitoring or alarms module (observability work lives under infra/observability).
* Remote-state bucket bootstrap is manual.
