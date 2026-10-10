# Verification run: CI, infrastructure and observability

> **Superseded rows (re-verified 2026-10-10, Node 24 for depcruise):** rows 7-8 and 10-13 below were taken mid-change. Current results: `pnpm lint` PASS; `pnpm -r test` PASS, 1299 tests in 15 packages; dependency-cruiser PASS, 0 violations (301 modules); i18n-check PASS, 119 keys; OpenAPI PASS, 159 operations; privacy inventory PASS, 94 tables / 601 fields, 31/31 tool tests (the ledger_account_types columns are now tagged). Terraform, promtool, actionlint, act, checkov, conftest and docker remain NOT VERIFIED.

Date: 2026-10-10. Scope: `.github/**`, `infra/**`, `tooling/observability/**`.
Honest summary: **no workflow has run on GitHub, no Terraform has been validated by Terraform, and no
Prometheus rule has been checked by promtool.** Everything below marked "verified" was run locally and
the result pasted from real output. Everything else is listed under NOT VERIFIED with the exact command.

Tools missing on this machine (all confirmed with `which`): terraform, docker, promtool, act, tflint,
checkov, conftest. Node here is v25.9.0 (the repo pins 24 in `.nvmrc`).

## Results

| # | Check | Tool | Result |
|---|---|---|---|
| 1 | All 4 workflow files parse as YAML and have name, on, jobs, workflow-level `permissions` | `node .github/scripts/validate-workflows.mjs` (new, uses the `yaml` package) | PASS. 4 files, 41 `uses:` references |
| 2 | Every job has `runs-on` and `timeout-minutes`; `needs` and `outputs` references resolve | same | PASS after fix (release.yml `guard` and `verify` had no timeout) |
| 3 | Action pinning | same, plus `--require-sha` | **FAIL by design of the current state.** 0 of 41 refs are SHA-pinned, all are version tags (no branch refs left: `instrumenta/conftest-action@master` was removed). SHAs cannot be resolved offline and were not invented. Renovate (`helpers:pinGitHubActionDigests`) opens the pinning PRs. The SLSA generator is exempt because it must be referenced by tag |
| 4 | Least-privilege permissions | same | Workflow level is `contents: read` everywhere. Elevated, job-scoped only: `security-events: write` (CodeQL analyze), `packages: write` + `id-token: write` (release build, provenance). `pull-requests: read` added to secret-scan |
| 5 | Referenced scripts and paths exist | same | PASS for scripts and `.nvmrc`. Warning: `apps/api/Dockerfile` does not exist (release is guarded by `vars.CONTAINER_REGISTRY`, so it is inert) |
| 6 | `pnpm typecheck` | pnpm 11.13.0 / turbo | PASS, 15/15 tasks |
| 7 | `pnpm lint` (`eslint .`) | eslint | **PASS on the first run (exit 0). FAIL on the final run, not caused by this task**: 140 errors, of which 1 is a real source finding in `apps/api/src/modules/auth/adapters/jwt-identity-verifier.ts:90` (`no-useless-assignment`, another agent's in-progress file) and the rest are lint errors inside `packages/domain/.stryker-tmp-domain/sandbox-*`, a transient Stryker sandbox that the ESLint config does not ignore. Files I own lint clean (`eslint .github/scripts tooling/observability`, exit 0) |
| 8 | `pnpm test` | turbo + vitest | PASS, 15/15 tasks, 893 tests (domain 390, analytics 100, policy 78, idempotency 54, api 53, mobile 36, db 36, privacy 33, outbox 30, auth-core 25, ui-native 18, validation 14, ui-tokens 12, feature-flags 10, i18n 4) |
| 9 | `pnpm build` | turbo | Exit 0 but **0 tasks executed**: no package defines a `build` script, so this gate proves nothing. Not used in CI |
| 10 | `pnpm depcruise` | dependency-cruiser 18.5 | **NOT VERIFIED.** Refuses to run on Node 25.9.0 ("^22 or ^24 or >=26"). All installed Node binaries here are 25.x. CI uses Node 24 |
| 11 | `pnpm i18n-check` and its tests | node --test | PASS: 117 keys parity OK, 7/7 tests, 3 warnings (identical AR/EN text for a phone placeholder and the two language names, which is expected) |
| 12 | OpenAPI validation | `node tooling/api/validate-openapi.mjs` (swagger-parser + contract rules) | PASS: 156 operations, 87 writes, 184 schemas. Now also run in CI (`contracts` job); before this change no workflow ran it |
| 13 | Privacy inventory check | `node tooling/privacy/check-inventory.mjs`, `node --test tooling/privacy/test/*.test.mjs` | **FAIL, genuine finding.** 7 untagged columns of `ledger_account_types` (migration `0011_ledger_account_types.sql`) are missing from `docs/privacy/data_inventory.yaml`; 29/31 tests pass, the 2 failures are the same gap. Not mine to fix (see needs). The new CI job will be red until the inventory is updated, which is the correct behaviour of the B1 gate |
| 14 | Observability generator in sync | `node tooling/observability/generate.mjs --check` | PASS: 15 generated files match `slos.yaml` |
| 15 | Observability unit tests | `node --test tooling/observability/test/*.test.mjs` | PASS 22/22. Note: `node --test tooling/observability/test` (directory form) fails with Node 25, use the glob |
| 16 | Prometheus rule structure and burn-rate windows | `node tooling/observability/validate-rules.mjs` (new, independent of the generator) | PASS: 8 files, 15 groups, 70 recording rules, 19 alerts, 8 SLOs. Fast tier reads 1h and 5m, slow tier 6h and 30m, thresholds equal 13.44 / 5.6 times the error budget, every series an alert reads is recorded, runbooks and dashboards exist. Negative check done by hand: changing 5m to 10m and a threshold to 0.03 made it exit 1 with 3 errors, then restored |
| 17 | Grafana dashboards | `JSON.parse` via the generator test and the validator | PASS: 7 dashboards valid JSON |
| 18 | Terraform structural review | `python3` script (kept in the session scratchpad, not committed): brace-matched HCL scan | PASS after fixes: every `var.*` declared, every module call supplies all required variables and no unknown ones, every `module.x.y` output exists, every resource reference resolves, every module pins `hashicorp/aws ~> 6.0` and `required_version >= 1.9.0`, no tabs, `=` alignment consistent (heuristic for `terraform fmt`) |
| 19 | Terraform hygiene | grep | No secret values (secrets module creates containers only, DB uses `manage_master_user_password`), no `aws_iam_access_key`, no ingress rule opens `0.0.0.0/0` (3 hits of `0.0.0.0/0`: two default routes and one HTTPS egress rule). Buckets: public access block, versioning, KMS SSE, TLS-only policy, optional object lock. RDS and Redis encrypted at rest and in transit, KMS rotation on |
| 20 | Dependency audit | `pnpm audit --audit-level high --prod` | **FAIL, genuine finding.** 4 vulnerabilities (2 high, 2 moderate), all transitive through `apps/mobile > expo > @expo/cli`: `node-forge <=1.4.1` (GHSA-86w9-cpqp-85rv) and `braces <=3.0.3` (GHSA-vfj7-8cjw-p6xm). The CI `dependency-audit` job will fail until overridden or upgraded. Lockfile and root `package.json` are not mine |

## Defects found and fixed in files I own

1. **Terraform: `for_each` over unknown values** (`modules/postgres`, `modules/redis`). The ingress rules used `for_each = toset(var.allowed_security_group_ids)` while the environments pass `module.compute.service_security_group_id`, which is unknown until apply. `terraform validate` would pass but the first `plan` would fail with "Invalid for_each argument". Changed to `count = length(...)` with an index.
2. **Terraform: log group could not use its KMS key.** The KMS module created keys with the default policy, which does not let `logs.<region>.amazonaws.com` use them, so `aws_cloudwatch_log_group` with `kms_key_id` fails at apply. The module now writes an explicit key policy (account root plus a CloudWatch Logs statement on the `logs` key, scoped by encryption context).
3. **Terraform: task execution role could not read CMK-encrypted secrets.** `GetSecretValue` alone is insufficient when the secret uses a customer key. Added `secrets_kms_key_arn` to the compute module with `kms:Decrypt` on it, wired in all three environments.
4. **Terraform: dev/staging/prod CI role used `resources = ["*"]`.** Narrowed to the cluster ARN and its service ARNs.
5. **Terraform: unused variable `github_repository`** in `modules/github-oidc` and no guard for `create_provider = false` with no existing ARN (prod and staging default to false). `allowed_subjects` must now start with `repo:<github_repository>:` and contain no wildcard, and a precondition fails fast on a missing provider ARN. Each environment now exports `github_oidc_provider_arn` so another environment can reuse it.
6. **Terraform hardening:** WAF `AWSManagedRulesKnownBadInputsRuleSet` added; RDS exports `postgresql` and `upgrade` logs to CloudWatch.
7. **CI: `release.yml` used `pnpm dlx` on a bare runner** (no pnpm installed, no Node setup). Added `pnpm/action-setup` and `actions/setup-node` to the build job. Added missing `timeout-minutes` to `guard` and `verify`.
8. **CI: `instrumenta/conftest-action@master`** (mutable branch ref, deprecated action) replaced by the pinned `conftest v0.56.0` release tarball, verified against the release `checksums.txt`.
9. **CI: Checkov could not have passed unconfigured.** Added `infra/terraform/.checkov.yaml` with 14 documented deferrals and passed it with `config_file`. `soft_fail` stays false. This list is from knowledge of the rule set, not from a run (see NOT VERIFIED).
10. **CI gaps closed:** OpenAPI validation, privacy inventory check, observability drift and rule validation, and a workflow lint were not run by any workflow. Added a `contracts` job. Added `pull-requests: read` to the gitleaks job, which lists PR commits through the API.

## NOT VERIFIED, with the command the owner must run

| Item | Why not verified | Exact command (from repo root) |
|---|---|---|
| Terraform syntax and provider schema | no terraform binary | `terraform fmt -check -recursive infra/terraform && for e in dev staging prod; do terraform -chdir=infra/terraform/environments/$e init -backend=false -input=false && terraform -chdir=infra/terraform/environments/$e validate; done` |
| Terraform plan, including the `count` fix, the KMS policy and the unknown-value behaviour | no cloud account, region undecided (ADR-0002) | `cd infra/terraform/environments/dev && cp backend.hcl.example backend.hcl && terraform init -backend-config=backend.hcl && terraform plan -var region=<ADR-0002> -var github_repository=<owner/repo>` |
| Provider lock file | cannot generate offline | `terraform -chdir=infra/terraform/environments/dev providers lock -platform=linux_amd64 -platform=darwin_arm64` then commit `.terraform.lock.hcl` for each environment |
| `aws_region.current.region` attribute and AWS provider 6.x names | no provider schema available | covered by `terraform validate` above |
| tflint | not installed | `tflint --recursive --chdir infra/terraform` |
| Checkov result and the skip list | not installed | `checkov -d infra/terraform --config-file infra/terraform/.checkov.yaml` |
| Conftest policies (`policy/terraform.rego`, flagged as unexecuted stubs by their own header) | not installed | `conftest test infra/terraform --policy infra/terraform/policy --parser hcl2 --all-namespaces` |
| Prometheus rules (PromQL parse, `for`, label rules) | no promtool | `promtool check rules infra/observability/prometheus/rules/*.yaml` |
| Rules fire correctly | no promtool, no metrics emitted yet (ADR-0006) | write `promtool test rules` unit tests once any SLI is instrumented |
| Grafana dashboards import | no Grafana | import each JSON in `infra/observability/grafana/dashboards/` into a scratch Grafana |
| Workflows execute | no act, no docker, no GitHub run | `act -W .github/workflows/ci.yml -j verify` (needs docker), or push a branch and read the Actions run |
| `actionlint` (expression and shell lint) | not installed | `actionlint .github/workflows/*.yml` |
| Actions SHA pinning | needs network to resolve | let Renovate open the digest-pin PR, then `node .github/scripts/validate-workflows.mjs --require-sha` |
| `google/osv-scanner-action/osv-scanner-action@v2` is a valid ref and `bridgecrewio/checkov-action@v12` input names | no network | first CI run |
| conftest 0.56.0 asset name and checksum file exist | no network | first CI run of the `iac` job |
| `pnpm depcruise` | Node 25 unsupported by dependency-cruiser | `nvm use 24 && pnpm depcruise` |
| `pnpm mutation` (Stryker) | about 4 minutes and another agent was running it in `packages/domain` during this check | `pnpm mutation` |
| Release pipeline (build, cosign, SLSA, verify) | no Dockerfile, no registry, no docker | after `apps/api/Dockerfile` exists and `CONTAINER_REGISTRY` is set, tag `v0.0.1-rc.1` on a scratch branch |
| Gitleaks | not installed | `gitleaks detect --config .github/gitleaks.toml` |

## Remaining observations (not changed)

* `ci.yml` job `mutation` runs on push to main or on a label; `docs/engineering/ci-cd.md` calls it "weekly" but no `schedule` trigger exists.
* `cdxgen@latest` in `sbom.yml` and `release.yml` is unpinned (already listed in `ci-cd.md`).
* `backend "s3"` with `dynamodb_table` is deprecated in recent Terraform in favour of `use_lockfile`; decide with ADR-0002.
* The `media` bucket has no bucket policy for the CloudFront origin access control, so the CDN will return 403 until one is added (listed as a known gap in `infra/terraform/README.md`).
* `.checkov.yaml` skips were not derived from a run and may be both too many and too few.
