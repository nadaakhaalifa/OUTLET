# ADR-0015: CI provenance, signing and quality gates

- Status: **Proposed** (owner approval; the Sigstore residency question and the SLSA level claim are open)
- Date: 2026-10-10
- Deciders: CTO, Security lead, Platform
- Spec refs: §T5 (supply chain), §T11, §A2.10, §P1 (SBOM/signing live before launch)

## Context and problem statement

The master prompt requires lockfiles, Renovate, audit + OSV, a CycloneDX SBOM per build, Sigstore cosign image signing, SLSA v1.0 provenance (Build L2 moving to L3), secret scanning and SAST. The repository has no deployable artifact yet and no Actions history, so the pipeline is designed now and proven when the first image exists. Money code (ledger, refunds) raises the cost of a compromised build.

## Decision drivers

- A deployer must be able to verify "this digest was built by this repository's CI from this commit".
- No long-lived signing or cloud keys.
- Cheap to run from day one; strict where money is involved.
- Does not pre-empt the cloud/region choice (ADR-0002).

## Options considered

1. **Keyless cosign + SLSA generator (reusable workflow) + CycloneDX attestation.** Identity is the GitHub OIDC workflow identity, logged in Sigstore's transparency log. Provenance comes from a separate isolated reusable workflow (the property that makes L3 achievable).
2. **KMS-backed cosign keys held by us.** Works fully offline of public Sigstore, but we then own key custody, rotation and an audit trail. More moving parts at team size one to three.
3. **Registry-native signing (provider-specific).** Ties us to the provider before ADR-0002.

## Decision (proposed)

Option 1 as the default, structured so option 2 is a swap of the `cosign sign` flags:

- `release.yml`: build by digest, CycloneDX SBOM of the image, `cosign sign` + `cosign attest --type cyclonedx`, provenance through `slsa-framework/slsa-github-generator` container generator, and a verification job that checks signature and provenance with the repository identity pinned.
- `ci.yml`: frozen lockfile install, typecheck, lint, tests, dependency-cruiser, i18n parity, gitleaks (full history), `pnpm audit` and OSV, IaC checks, mutation testing on main.
- `codeql.yml`: CodeQL `security-extended`, weekly and on PR. Semgrep is deferred.
- Deploys reference **digests only**, and the deploy step runs `cosign verify` before rollout.
- Third-party actions are pinned to commit SHAs (Renovate digest pinning) before the first production release.
- Workflows default to `permissions: contents: read`; elevated permissions are granted per job (`id-token: write` only on build/provenance).

## Consequences

- Public Sigstore records signing identities (repository name, workflow ref) in a public transparency log. That is not personal data but is metadata; **VERIFY BEFORE LAUNCH** that it is acceptable, otherwise use option 2 or a private Sigstore.
- Claiming **SLSA Build L3** requires that builds run only on GitHub-hosted runners, the build does not see signing material, and consumers verify provenance. The pipeline is shaped for L3 but no level should be claimed externally until a real release is verified against the spec.
- `cdxgen` and several actions are consumed unpinned in the first draft; pinning is a launch gate (P1: SBOM/signing live).
- Mutation testing on every PR is too slow (about 4 minutes for the domain alone), so it runs on main and on a label.

## Owner decisions required

1. Public Sigstore versus private/KMS-backed keys (Security, Legal if residency applies).
2. Which SLSA level the company will publicly state, if any.
3. Whether to add Semgrep and ZAP now or when staging exists.
4. Registry location (follows ADR-0002).
