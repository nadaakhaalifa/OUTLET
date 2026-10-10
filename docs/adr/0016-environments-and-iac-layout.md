# ADR-0016: Environments and infrastructure-as-code layout

- Status: **Proposed, blocked on ADR-0002** (region and provider) and on the orchestrator choice
- Date: 2026-10-10
- Deciders: CTO, Platform, Security lead
- Spec refs: §T7, §T5 (ops security), §T9 (RPO/RTO), §T10 (scale to zero non-prod)

## Context and problem statement

T7 asks for Terraform with remote state and policy-as-code, containers on ECS or Kubernetes, three environments (dev, staging prod-like with synthetic data only, prod), region per ADR-0002, CDN + WAF, secrets manager, and OIDC from CI. Provider and region are not decided (PDPL residency, open questions 1, 2, 8), and no cloud account exists.

## Options considered

1. **Environments as thin compositions of shared modules, one state per environment, provider and region as variables.** Interfaces stable, internals provider-specific.
2. **Terraform workspaces over one root.** Less duplication but a single code path hides prod-only differences and blast radius is shared.
3. **Cloud-neutral abstraction layer (Crossplane/Pulumi-style).** Premature; adds a platform to run before the first workload exists.
4. **Wait for ADR-0002 and write nothing.** Zero risk of rework, but blocks the CI/IaC scanning gates and the shape review.

## Decision (proposed)

Option 1:

- `infra/terraform/modules/*`: network, kms, postgres, redis, object-storage, cdn-waf, compute, secrets, github-oidc.
- `infra/terraform/environments/{dev,staging,prod}`: thin compositions; **`region` has no default**; `cloud_provider` is validated so only the implemented provider can be applied.
- Remote state per environment with locking and encryption; backend values passed at init, never committed.
- Environment isolation: separate state, roles, KMS keys and CI trust subject (`environment:<name>`). Staging holds synthetic data only and has no network or IAM path to production.
- Secrets: containers only in Terraform; values set out of band so they never enter state.
- Policy-as-code: Conftest rules (region not hard-coded, encryption, no public buckets, no access keys, no secret versions) plus Checkov, both in CI.
- Modules are written against AWS shapes as a **working assumption only**.

## Consequences

- If ADR-0002 forces in-country or non-hyperscaler hosting, module internals are rewritten; the environment layout, variable contract and policy intent survive.
- The skeleton has not been validated with `terraform validate` or run through Conftest on the authoring machine; the first CI run is the real test.
- Three near-identical environment folders are accepted duplication in exchange for explicit prod-only settings and reviewable diffs.
- Production must not be applied until ADR-0002 is Accepted.

## Owner decisions required

1. Provider and region (from ADR-0002).
2. ECS Fargate versus Kubernetes.
3. Single account with separate state versus one account per environment (recommended: separate accounts once budget allows).
4. Waiting-room product (build vs buy) for drops.
