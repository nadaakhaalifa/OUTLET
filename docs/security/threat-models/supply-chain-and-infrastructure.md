# Threat model: supply chain, CI/CD and infrastructure

Status: Draft for review · Date: 2026-10-10 · Method: STRIDE per element · Spec refs: §T5, §T7, §T11, §B8 · Modules: monorepo, CI, build, deploy, environments

## What exists in the repo today
- `pnpm-lock.yaml` is committed and the root `package.json` pins `packageManager` and `engines`; `.nvmrc` pins Node.
- `.gitignore` excludes `.env` and `.env.*` (except `.env.example`).
- `dependency-cruiser`, Stryker, ESLint and `typescript-eslint` are installed as root dev dependencies but no configuration files exist yet (checked with `find` on 2026-10-10); there is no `.github` directory and no CI.
- `infra/` contains only `.gitkeep`.

## Threats and controls
| ID | STRIDE | Threat | Control | Proving test | Status |
|---|---|---|---|---|---|
| SUP-S1 | S | Malicious or typosquatted dependency | Lockfile, Renovate with review, `pnpm audit` and OSV in CI, install scripts reviewed or disabled by policy, minimum package age policy considered | SUP-T01 CI fails on a known-vulnerable fixture dependency | partial (lockfile committed: `pnpm-lock.yaml`; audit and Renovate planned) |
| SUP-T1 | T | CI compromise injects code into artifacts | Hardened CI, OIDC to cloud with no long-lived keys, pinned action versions by digest, cosign image signing, SLSA v1.0 Build L2 then L3 provenance, CycloneDX SBOM per build | SUP-T02 deploy step verifies signature and provenance, unsigned image refused | planned |
| SUP-T2 | T | Unreviewed change to money or security code | CODEOWNERS with 2 reviews for money and security paths, branch protection, conventional commits | SUP-T03 repository settings check (as code) in CI | planned |
| SUP-R1 | R | Cannot attribute a production change | Signed commits or provenance, deploy log with actor, change record in audit log | SUP-T04 each deploy has provenance attestation attached | planned |
| SUP-I1 | I | Secrets committed or leaked through build logs | Secret scanning pre-commit and in CI, secrets manager, `.env*` ignored | `.gitignore` excludes `.env*` (partial); SUP-T05 secret-scan CI fixture with a canary secret fails the build | partial (`.gitignore`); scanning planned |
| SUP-I2 | I | Staging reaches production data or holds real personal data | Separate accounts and networks, synthetic data only in dev and staging, egress policies, IaC policy-as-code (OPA/Conftest) | SUP-T06 staging role cannot read production resources; data-classification scan of staging finds no real personal data patterns | planned |
| SUP-D1 | D | Layer 7 flood or drop-day traffic | CDN, WAF, DDoS protection, waiting room that fails closed for drops, autoscaling | SUP-T07 load test at 20x baseline per §T9 | planned |
| SUP-E1 | E | Over-privileged IAM, containers running as root, shadow endpoints | Least-privilege IAM, IaC scanning (Checkov or tfsec), container scanning, API catalog generated from code with no undeclared routes | SUP-T08 route inventory test: every registered route appears in generated OpenAPI | planned |
| SUP-E2 | E | Architecture erosion lets modules bypass policy and ledger boundaries | dependency-cruiser fitness functions (no cross-module imports except public index, no infra in domain) | SUP-T09 dependency-cruiser CI rule set; tool present as a dev dependency, configuration planned | planned |

## Residual risk
Package registries remain a trust root. SBOM and provenance make incidents traceable but do not prevent the first malicious install.
