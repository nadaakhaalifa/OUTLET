# DevOps, Security, Observability & Quality Toolchain for Outlet NK (as of 2026-11-06)

Scope: 4–8 engineers, web-first marketplace, PCI SAQ A, ASVS 5.0 L2, PDPL 72h breach notice. Every figure is labelled with its year. Most prices come from third-party aggregators, so they are marked UNVERIFIED unless a vendor page is cited. Check official pricing pages before committing a budget.

## CI/CD (GitHub Actions, remote cache, previews, SLSA/SBOM/signing, Renovate, SAST, secrets)

### Takeaway
GitHub Actions remains the default. Hosted-runner prices were cut about 39–40% on 1 Jan 2026. GitHub's native artifact attestations (Sigstore-backed) give SLSA Build L2 out of the box, and L3 via audited reusable workflows. Paid GHAS (Secret Protection $19 + Code Security $30 per active committer per month, 2025 list) is the main CI security cost. Semgrep CE plus free push protection on public repos are the cheaper alternatives.

### Cited Findings
- (2026) GitHub-hosted runner prices fell about 39–40% from 1 Jan 2026, and a $0.002/min platform charge is built into those rates — [GitHub resources](https://resources.github.com/actions/2026-pricing-changes-for-github-actions/)
- (Dec 2025) GitHub announced a $0.002/min charge for self-hosted runners from 1 Mar 2026 — [GitHub changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/). (Jan 2026) Socket reports the self-hosted charge was postponed after pushback. Its current status is UNVERIFIED — [Socket](https://socket.dev/blog/github-actions-pricing-whiplash)
- (2025, still current) GitHub Secret Protection costs $19 and Code Security $30 per active committer per month. Both can be bought on the Team plan without Enterprise — [GitHub changelog](https://github.blog/changelog/2025-03-04-introducing-github-secret-protection-and-github-code-security/), [GHAS for Team orgs](https://github.blog/changelog/2025-04-01-github-advanced-security-is-here-for-github-team-organizations)
- Licences count active committers over the last 90 days — [GitHub docs](https://docs.github.com/en/code-security/how-tos/secure-at-scale/configure-organization-security/configure-specific-tools/estimating-the-price-of-secret-protection)
- Artifact attestations alone give SLSA v1.0 Build L2. Reusable workflows that isolate the build give L3. Builds use `actions/attest-build-provenance` (needs `id-token: write` and `attestations: write`). SBOMs come from anchore `sbom-action` (Syft) plus `actions/attest-sbom`. Verification uses `gh attestation verify --signer-workflow` — [GitHub docs](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds), [SLSA L3 docs](https://docs.github.com/es/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-and-reusable-workflows-to-achieve-slsa-v1-build-level-3)
- GitHub signs attestations with Sigstore — [GitHub docs](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds)

### Inferences
- The spec asks for "cosign signing". GitHub attestations already use Sigstore, so cosign can be kept only for signing container images in ECR (`cosign sign --yes` with keyless OIDC), or dropped in favour of `gh attestation verify` at deploy time. Record the choice in an ADR.
- For 6 committers, GHAS costs about $294/mo (2025 list). A cheaper MVP stack is CodeQL (free only on public repos, so it does not apply here), Semgrep CE in CI, gitleaks pre-commit and in CI, and Renovate (free GitHub app). Buy Secret Protection ($114/mo for 6 committers) first because it adds push protection, then add Code Security later.
- Turborepo remote cache: Vercel's hosted cache, or self-hosted with the open-source `ducktors/turborepo-remote-cache` on S3. Either costs close to $0 at this scale. This is from training knowledge, not verified in this pass.
- Preview environments: for a web-first Next.js app, Vercel or Cloudflare previews are the cheapest. An ECS per-PR preview stack costs more ops time. Use synthetic data only (spec §T7).

### Gaps
- Turborepo remote-cache pricing and the GitHub Team seat price ($4/user/mo historically) were not re-verified for 2026.
- Semgrep Team pricing was not retrieved.
- Whether the self-hosted runner fee ever took effect is unconfirmed.

## IaC and runtime (Terraform/OpenTofu vs Pulumi; ECS Fargate vs EKS vs PaaS; managed Postgres)

### Takeaway
For 4–8 engineers, use OpenTofu or Terraform with ECS Fargate and RDS PostgreSQL Multi-AZ, plus RDS Proxy or PgBouncer. EKS adds cluster operations that a small team rarely recovers in value. This recommendation is inferred, with limited fresh sources.

### Cited Findings
- (2026, third-party, UNVERIFIED) RDS PostgreSQL db.t4g.medium in me-central-1 (UAE) costs about $55/mo on demand, Single-AZ assumed — [Bytebase dbcost](https://www.bytebase.com/dbcost/rds/instance/db.t4g.medium/)
- (2026, us-east-1) db.t4g.medium costs $0.065/hr Single-AZ and $0.130/hr Multi-AZ. Multi-AZ is exactly double — [InfraTally](https://infratally.com/articles/aws-rds-pricing-explained-2026/)
- RDS Multi-AZ keeps a standby in another AZ and bills per instance-hour — [AWS RDS PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing)

### Inferences
- MVP database: Multi-AZ db.t4g.medium or db.m7g.large in me-central-1 costs roughly $110–$350/mo before storage and backups (estimate).
- The spec needs pg_cron and pgvector. Both are supported on RDS PostgreSQL 16+ (training knowledge, verify). PITR is built in (up to 35 days). Use RDS Proxy (billed per vCPU), or PgBouncer as a Fargate sidecar for the transaction-mode pooling the spec requires.
- The region choice depends on ADR-0002 (PDPL residency). A PaaS (Render, Railway, Fly) gives weaker control over region and residency, so prefer AWS for P2/P3 data.
- OpenTofu (MPL, Linux Foundation) avoids the Terraform BSL licence. Pulumi lets the team write TypeScript, but the state service costs money. Choose OpenTofu plus Conftest (spec §T7).

### Gaps
- No primary 2026 source was fetched for Fargate in me-central-1, RDS Proxy pricing, or OpenTofu vs Terraform adoption.

## Observability (OTel + Grafana Cloud vs Datadog vs New Relic vs self-host; Sentry; SLO tooling)

### Takeaway
At small scale, OTel with Grafana Cloud Pro ($19/mo base plus usage, 2026) and Sentry Team (about $26–29/mo, 2026) is far cheaper and more portable than Datadog (about $46/host/mo for infrastructure plus APM, 2026). Grafana Cloud also includes SLO features and k6.

### Cited Findings
- (2026, UNVERIFIED aggregators) Grafana Cloud Pro costs a $19/mo platform fee plus usage. Metrics run about $6.50–8 per 1k series. The free tier keeps data 14 days and includes k6. Enterprise starts at a $25k/yr commitment — [Last9](https://last9.io/blog/grafana-cloud-pricing/), [CostBench](https://costbench.com/software/developer-tools/grafana/)
- (2026, UNVERIFIED) Datadog Infrastructure Pro costs $15 (annual) to $18/host/mo, and APM $31 (annual) to $36/host/mo. The free plan covers up to 5 hosts. Sidecar mistakes can count every pod as a host — [SigNoz](https://signoz.io/blog/datadog-pricing/), [Last9](https://last9.io/blog/datadog-pricing-all-your-questions-answered.md)
- (2026, UNVERIFIED) Sentry Team costs $26/mo annual or $29/mo monthly, and Business $80–89. Cron, uptime and profiling are billed as extras — [Capterra](https://www.capterra.com/p/165426/Sentry/pricing/), [Toolradar](https://toolradar.com/tools/sentry/pricing)

### Inferences
- Self-hosted SigNoz or LGTM avoids licence fees but costs engineering time, about 0.1–0.2 FTE (estimate). It is not worth it for 4–8 engineers before growth stage. Grafana Cloud keeps the option to self-host later because both use OTel.
- PII redaction must happen in the OTel Collector before data leaves the region. Check whether Grafana Cloud has a region compatible with ADR-0002.
- SLO tooling: Grafana SLO (in Cloud), or Sloth or Pyrra (open source) generating multi-burn-rate Prometheus rules.

### Gaps
- New Relic 2026 pricing was not retrieved.
- Grafana Cloud's data regions near Egypt were not checked.

## Security (WAF/bot, Waiting Room, secrets, passkeys, ZAP, MENA pen tests, bug bounty)

### Takeaway
Use Cloudflare Business (about $200–250/mo, 2026, unverified), which includes WAF and one basic Waiting Room. Full Bot Management is likely Enterprise-only. Budget about $4k–15k (2026) per web-app pen test in the region. A paid bug bounty costs $25k–40k/yr or more in platform fees alone, so start with a free VDP or security.txt instead.

### Cited Findings
- Waiting Room is available on the Business and Enterprise plans (and Project Fair Shot). One basic waiting room is included on Business and Enterprise. Advanced waiting rooms are Enterprise-only purchases — [Cloudflare docs](https://developers.cloudflare.com/waiting-room/), [plans page](https://codex-container-api-docs.previews.developers.cloudflare.com/waiting-room/plans/index.md)
- (2026, UNVERIFIED) Cloudflare Business costs $200/mo annual or $250/mo monthly. Sources conflict on whether Business includes bot management. Most say full Bot Management is Enterprise-only — [eastondev](https://eastondev.com/blog/en/posts/dev/20251201-cloudflare-pricing-compare/), [projectcostestimator](https://projectcostestimator.com/blog/cloudflare-cost-2026)
- (2026, vendor marketing, UNVERIFIED) UAE web-app pen tests: AED 25k–55k for one role (about $6.8k–15k), or USD 3.5k–10k with a retest at $700–1,400 — [pentest-ae](https://pentest-ae-v1.pages.dev/blog/penetration-testing-cost-uae/), [Kolonell](https://kolonell.com/en/blog/web-application-pentest-cost-dubai-2026). Global range: $5k–30k — [Bright Defense](https://www.brightdefense.com/resources/penetration-testing-pricing). No Egypt pricing was found.
- (2026, UNVERIFIED) A HackerOne private bounty costs about $25k–40k/yr in platform fees plus about 5% on payouts. A VDP-only program costs $8k–12k/yr — [Synack](https://www.synack.com/blog/hackerone-pricing/). The Intigriti median is about $42.5k/yr from a small sample — [CostBench](https://costbench.com/compare/hackerone-vs-intigriti/)

### Inferences
- For drops, Enterprise bot management is costly. Combine the Business WAF, Turnstile, App Attest and Play Integrity, and server-side rate limits (spec API6) until scale justifies Enterprise.
- Secrets: AWS Secrets Manager (about $0.40 per secret per month, from training knowledge) with OIDC from CI. Use KMS for the field-encryption DEKs.
- Passkeys: SimpleWebAuthn (`@simplewebauthn/server` and `/browser`) is the de facto TypeScript library. Training knowledge, version not verified.
- ZAP baseline scans can run in CI on staging for free (`zaproxy/action-baseline`). Run full scans nightly.
- PDPL 72h: the incident tooling needed is an on-call pager (Grafana OnCall/IRM or PagerDuty), the breach runbook, and WORM audit logs (S3 Object Lock).

### Gaps
- Official Cloudflare Waiting Room and Bot Management prices.
- Named MENA pen-test vendors with a CREST listing in Egypt.
- PagerDuty pricing for 2026.

## Quality tooling (Playwright, k6, Pact/PactFlow, Stryker, dependency-cruiser): realistic for MVP?

### Takeaway
Playwright, dependency-cruiser, Stryker (scoped to the ledger, pricing and reservation code) and k6 OSS are free and worth having at MVP. PactFlow (about $99/mo, unverified) and k6 Cloud can wait: a self-hosted Pact Broker, or Pact only on PSP and courier adapters, is enough at first.

### Cited Findings
- (2026, UNVERIFIED aggregator) PactFlow lists a "Basic" plan at $99/mo, and a free version exists — [SoftwareSuggest](https://www.softwaresuggest.com/pactflow), [TrustRadius](https://www.trustradius.com/products/pactflow/pricing)
- The Grafana Cloud free tier includes k6 tests — [Last9](https://last9.io/blog/grafana-cloud-pricing/)

### Inferences
- MVP must-haves: Playwright E2E, unit and property tests (fast-check), dependency-cruiser fitness functions, negative authorization tests, and Stryker run nightly on critical modules only (it is slow, so not per PR). Run k6 locally or in CI before launch and drops.
- Later: full Pact across apps, k6 Cloud for 20× load, and the Maestro iOS farm (the product is web-first now).
- Overhead: maintaining the full A2.10 matrix probably takes about 1 engineer-day/week across the team. This is an estimate with no source.

### Gaps
- No primary source for Stryker runtime costs, or for the PactFlow and k6 Cloud tiers in 2026.

## Feature flags (OpenFeature + flagd / Unleash / GrowthBook)

### Takeaway
Use the OpenFeature SDK with flagd (free, file or Git-backed) for kill switches at MVP. Add self-hosted GrowthBook (MIT, free) when A/B experimentation starts. Unleash's paid self-hosted tier starts at about $375/mo (2026, unverified).

### Cited Findings
- (2026) GrowthBook is free for up to 3 users (Starter) and the self-hosted version is MIT-licensed and free. Pro is about $40/seat/mo (UNVERIFIED) — [GrowthBook pricing](https://growthbook.io/pricing), [CostBench](https://costbench.com/software/feature-flags/growthbook/)
- (2026, UNVERIFIED) Unleash self-hosted Enterprise costs $75/seat/mo with a 5-seat minimum ($375/mo). It has official OpenFeature providers. GrowthBook's claim that the Unleash OSS edition will be shut down at end of 2026 is a competitor claim and is unconfirmed — [CostBench](https://www.costbench.com/software/feature-flags/unleash/), [GrowthBook blog](https://www.growthbook.io/blog/unleash-alternatives), [DeployHQ](https://www.deployhq.com/blog/feature-flag-tools-compared)

### Gaps
- GrowthBook's OpenFeature provider status was not verified.

## Product analytics (PostHog self-host vs EU cloud; ClickHouse)

### Takeaway
PostHog EU Cloud (Frankfurt) gives 1M free events per month (2026) and is the cheapest start. However, EU hosting is a cross-border transfer under PDPL. Either obtain the transfer licence with a TIA, or keep only pseudonymous, PII-free events, decided in ADR-0002. Self-hosting PostHog requires running ClickHouse, which is heavy for 4–8 engineers.

### Cited Findings
- PostHog Cloud offers US (Virginia) or EU (Frankfurt) hosting. The first 1M analytics events per month are free, and the code is MIT-licensed for self-hosting — [PostHog EU](https://posthog.com/eu)
- (2026, UNVERIFIED) Session replay includes about 5k free recordings, then about $0.005 each. Analytics overage is about $0.00005 per event — [Schematic](https://schematichq.com/blog/posthog-pricing)

### Inferences
- Consent gating (spec §B1) means PostHog initialises only after `analytics` consent. Strip PII before sending.
- The spec's ClickHouse warehouse can be ClickHouse Cloud later (growth stage). Pricing was not retrieved.

### Gaps
- ClickHouse Cloud pricing.
- Whether PostHog's EU limits match its US limits.

## Total estimated monthly tooling cost (2026 USD, excluding core compute and DB unless noted; estimates)

### Takeaway
MVP is roughly $700–1,500/mo plus a one-off pen test of about $5k–15k. Growth stage is roughly $2.5k–6k/mo plus a yearly pen test and an optional bounty program at $25k–40k/yr or more.

### Cited Findings
- Component prices are cited in the sections above, mostly 2026 aggregators and UNVERIFIED.

### Inferences
- **MVP (6 engineers), per month:**
  - GitHub Team: about $24 (unverified)
  - Actions minutes: about $50–150
  - GH Secret Protection: $114
  - Cloudflare Business: $200–250
  - Grafana Cloud Pro: $19 plus about $100–300 usage
  - Sentry Team: about $29–80
  - PostHog: $0–100
  - flagd and GrowthBook self-hosted: about $0 plus compute
  - Renovate, Semgrep CE, ZAP, Playwright, k6 OSS, Stryker, dependency-cruiser: $0
  - Secrets Manager and KMS: about $20–50
  - Pager: about $0–100
  - Total: about $700–1,300/mo
  - AWS runtime (Fargate plus RDS Multi-AZ plus Redis, in me-central-1) is separate, roughly $600–1,500/mo (estimate)
- **Growth, per month:**
  - Add GH Code Security: about $240 for 8 committers
  - Grafana usage: $500–1,500
  - Sentry Business: about $89 or more
  - PostHog paid: $200–800
  - PactFlow: about $99 or more
  - k6 Cloud usage
  - Cloudflare Enterprise (bot management and advanced waiting room): quote-only, likely thousands per month (unverified)
  - Bug bounty: about $2–3.5k/mo amortised
  - Total: about $2.5k–6k/mo excluding Cloudflare Enterprise

### Gaps
- All totals are back-of-envelope estimates built on aggregator prices. Validate them against vendor quotes and region-specific AWS calculator runs.
