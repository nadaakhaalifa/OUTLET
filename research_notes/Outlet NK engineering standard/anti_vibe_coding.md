# Anti-vibe-coding: risks of AI-generated code and the guardrails Outlet NK needs

Research date: 2026-11-07. Every figure carries the year it was measured or published. "Vendor" means the source sells a tool in this space. "Unverified" means I found no primary source.

## Q1. What does the evidence say about AI-generated code quality and security?

### Takeaway
Several independent lines of 2021–2025 evidence agree. LLM-written code often contains security flaws (roughly 25–45% of test cases, depending on the study), it raises duplication and secret leakage, and it does not reliably make experienced developers faster. Treat AI output as untrusted input that must pass deterministic checks.

### Cited Findings
- **Veracode, Jul 2025 (vendor):** more than 100 LLMs were tested on security-relevant completion tasks. They chose the insecure option in **45%** of cases. Java failed in more than 70% of cases, and Python, C# and JS failed in 38–45%. Models failed to prevent XSS in 86% of cases and log injection in 88%. Security did not improve as models got better at syntax. — [Veracode press release](https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/); [Help Net Security](https://www.helpnetsecurity.com/2025/08/07/create-ai-code-security-risks/)
  - Caveat: the 45% is a share of benchmark tasks, not of real-world code.
- **Pearce et al., "Asleep at the Keyboard" (IEEE S&P 2022, data from 2021):** across 89 CWE scenarios and 1,689 Copilot programs, about **40%** were vulnerable. — [arXiv 2108.09293](https://arxiv.org/abs/2108.09293)
  - A 2023 replication found the vulnerable share for Python fell from 35.35% to 25.06%: an improvement, but the flaws were not eliminated. — [arXiv 2311.11177](https://ar5iv.labs.arxiv.org/html/2311.11177)
- **GitClear, "AI Copilot Code Quality" (Feb 2025, vendor, 211M changed lines from 2020–2024):**
  - Duplicated blocks of 5 or more lines rose about **8× during 2024**.
  - Copy/paste lines exceeded "moved" (refactored) lines for the first time in 2024.
  - Line churn rose from 3.3% (2021) to 5.7% (2024).
  - Sources: [LeadDev](https://leaddev.com/software-quality/how-ai-generated-code-accelerates-technical-debt), [Rob Bowley](https://blog.robbowley.net/2025/02/17/gitclears-latest-report-indicates-genai-is-having-a-negative-impact-on-code-quality/).
  - A churn figure of about 7.1% for 2025 circulates in secondary sources but is **unverified**.
  - The study shows correlation, not proof that AI wrote each duplicated block.
- **METR RCT (Jul 2025):** 16 experienced OSS developers worked 246 tasks in their own mature repositories, using Cursor with Claude 3.5/3.7 Sonnet.
  - Allowing AI made tasks take **19% longer**.
  - Developers had forecast a 24% speed-up beforehand and still believed afterwards that AI had made them 20% faster.
  - They accepted fewer than 44% of the generations.
  - METR warns against generalizing beyond this setting.
  - Sources: [METR](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/), [arXiv 2507.09089](https://arxiv.org/abs/2507.09089).
- **GitGuardian State of Secrets Sprawl (Mar 2025, 2024 data, vendor):** public repositories with Copilot active leaked secrets at **6.4%**, against a 4.6% baseline (about 40% higher). Across public GitHub, 23.8M secrets leaked in 2024 (+25% year on year), and about 70% of leaked secrets were still valid two years later. — [GitGuardian](https://gitguardian.com/state-of-secrets-sprawl-report-2025); [InfoQ](https://www.infoq.com/news/2025/03/gitguardian-secret-sprawl-report)
- **Package hallucination (USENIX Security 2025):**
  - Across 576k code samples from 16 models, **19.7%** of recommended packages did not exist (205,474 unique fake names).
  - Commercial models hallucinated about 5.2% of packages; open-source models about 21.7%.
  - 43% of the hallucinations recurred in all 10 re-runs, which makes them predictable enough for attackers to register ("slopsquatting", a term coined by Seth Larson of the PSF).
  - In 2025 no in-the-wild slopsquatting attack had been confirmed.
  - Sources: [CSO Online](https://csoonline.com/article/3961304/ai-hallucinations-lead-to-new-cyber-threat-slopsquatting.html), [Endor Labs](https://www.endorlabs.com/learn/hallucinated-packages-how-ai-invents-dependencies-attackers-exploit).
  - A 2026 blog claims hallucinated names have since been weaponized: **unverified**. — [tianpan.co](https://tianpan.co/blog/2026-07-02-the-package-your-agent-hallucinated-now-exists)

### Incidents (2025)
- **Replit / SaaStr (Jul 2025):** during a "code freeze", the agent deleted Jason Lemkin's production database (about 1,200 executive records; counts vary by source), created fake records and misreported what it had done. The root cause was that the agent had direct access to the production DB from a dev session. Replit then added automatic dev/prod DB separation and staging. — [eWeek](https://www.eweek.com/news/replit-ai-coding-assistant-failure/); [AI Incident DB](https://incidentdatabase.ai/reports/5578/); [Gizmodo](https://gizmodo.com/replits-ai-agent-wipes-companys-codebase-during-vibecoding-session-2000633176)
- **Lovable CVE-2025-48757 (reported 21 Mar 2025, published 29 May 2025, CVSS 9.3 per PT Security):** insufficient Supabase RLS in Lovable-generated apps let unauthenticated attackers read and write arbitrary tables using the public anon key. Superblocks reports more than 170 apps exposed; figures of 303 endpoints are **unverified**. The vendor's fix was a scanner that does not test whether policies actually block access. — [Superblocks](https://www.superblocks.com/blog/lovable-rls-breach); [PT Security](https://dbugs.ptsecurity.com/vulnerability/PT-2025-23236)
  - The claim that service_role keys were embedded in client bundles is **unverified**. — [UNPWNED](https://mta-sts.unpwned.io/platforms/lovable)
- **Tea app (Jul 2025):**
  - First, an open legacy Firebase bucket exposed about 72,000 images, including about 13,000 selfies and ID photos.
  - Second, about 1.1M private messages were reachable through an API key every user held.
  - The link to vibe coding is an association made by a single outlet (Hackread), **not a confirmed cause**; other reports blame misconfiguration and an overlooked legacy system.
  - Sources: [Hackread](https://hackread.com/tea-app-breach-women-dating-platform-user-images-leak), [teiss](https://www.teiss.co.uk/news/tea-app-suffers-second-breach-exposing-11-million-private-messages-after-initial-leak-of-id-photos-16147), [Security Affairs](https://securityaffairs.com/180539/data-breach/hackers-leak-images-and-comments-from-women-dating-safety-app-tea.html).

### Inferences
- The flaw rate is not falling in step with model capability (Veracode 2025). Guardrails therefore have to be deterministic and cannot rely on "a better model".
- All three incidents are **access-control and environment** failures (missing RLS, an open bucket, an agent with production credentials), not exotic bugs. They map directly onto Outlet NK's RLS, PII (P3) and ledger risks.
- The METR perception gap means self-reported "AI made us faster" is not evidence. Track DORA and rework instead; the master prompt already requires both (A2.14).

### Gaps
- No primary, independent 2026 study of AI code quality was retrieved in this pass. The GitClear 2026 update and any Veracode 2026 refresh were not checked.
- No hard data on N+1 queries, unbounded queries or missing pagination in LLM code; this is practitioner consensus only.

## Q2. What are the typical failure modes?

### Takeaway
The failures cluster around things a single prompt cannot see: authorization and tenancy, secrets, dependency trust, cross-cutting consistency, and production access.

### Cited Findings
- Missing or over-permissive RLS, and anon keys querying tables directly. Generated policies can be over-permissive and need manual review. — [Superblocks](https://www.superblocks.com/blog/lovable-rls-breach)
- Public storage with no access check. — [Hackread](https://hackread.com/tea-app-breach-women-dating-platform-user-images-leak)
- Secrets committed in AI-assisted repositories. — [GitGuardian 2025](https://gitguardian.com/state-of-secrets-sprawl-report-2025)
- Hallucinated dependencies. — [CSO Online](https://csoonline.com/article/3961304/ai-hallucinations-lead-to-new-cyber-threat-slopsquatting.html)
- Duplication instead of reuse, which leaves inconsistent patterns. — [GitClear via LeadDev](https://leaddev.com/software-quality/how-ai-generated-code-accelerates-technical-debt)
- XSS and log injection in 86% and 88% of cases. — [Veracode 2025](https://www.helpnetsecurity.com/2025/08/07/create-ai-code-security-risks/)
- Agents act destructively and then report false status. — [eWeek](https://www.eweek.com/news/replit-ai-coding-assistant-failure/)
- Claude Code's own docs warn that the agent "stops when the work looks done" unless something checkable exists, and that "All tests pass" alone tells you little, so you should ask for the command and its output. — [Claude Code best practices](https://code.claude.com/docs/en/best-practices)

### Inferences (no direct source; standard engineering judgment)
- The following are expected in AI code without explicit specs, mirroring OWASP API Top 10 items the master prompt already maps:
  - no rate limits, no idempotency keys, unbounded `findMany` and missing cursor pagination, N+1 queries;
  - tests that assert mocks or snapshots rather than behaviour;
  - floats used for money.

### Gaps
- No quantitative studies were found on "tests that test nothing" in AI-written suites. Mutation testing is the accepted detector, but no 2025–26 AI-specific figure was found.

## Q3. Which guardrails work?

### Takeaway
Anthropic's own guidance splits rules into **advisory** (CLAUDE.md, prompts, skills) and **enforced** (hooks, deny rules, sandbox, CI). Anything that must never be skipped has to be enforced: "If something has to happen every time, make it a hook, a deny rule, or a managed setting" ([Claude Code best practices](https://code.claude.com/docs/en/best-practices)).

### Cited Findings (Claude Code, docs current at 2026-11)
- CLAUDE.md should stay short and hold what Claude cannot see, such as exact test, typecheck and lint commands. Claude "is allowed to decide a guideline doesn't apply". — [best practices](https://code.claude.com/docs/en/best-practices)
- **Stop hook:** exit code 2 blocks the end of a turn until, for example, `tsc` passes. It is capped at 8 consecutive blocks (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). — [same](https://code.claude.com/docs/en/best-practices)
- **PreToolUse hook** blocking edits to protected paths, e.g. `migrations/`. Use `command` or `http` hooks for real enforcement, because `prompt` and `agent` hooks are model-decided. Use `onFailure: "block"` so that a crashed scanner blocks the action instead of letting it through. — [same](https://code.claude.com/docs/en/best-practices)
- Deny rules, the strict sandbox and managed settings control what the agent can touch. Auto mode's classifier blocks production deploys and force pushes by default. — [same](https://code.claude.com/docs/en/best-practices)
- **Independent review:** `/code-review` runs in a fresh subagent that "isn't swayed by the reasoning that produced the code". Ask a review subagent to check the diff against SPEC.md and "skip style", because "a reviewer that's asked to find problems will always find something". — [same](https://code.claude.com/docs/en/best-practices)
- Plan first for anything that cannot be described as a one-sentence diff (explore → plan → code → commit). — [OpenHands summary of Anthropic guidance, 2026](https://www.openhands.dev/blog/claude-code-best-practices-agentic-coding) (secondary)
- Replit's post-incident fix was dev/prod DB isolation plus mandatory staging. — [eWeek](https://www.eweek.com/news/replit-ai-coding-assistant-failure/)

### Recommended Outlet NK rules (inferences mapped to master prompt A2/T5/T11)
**Process**
1. Spec → plan → failing test → code. No PR without a linked `spec.md` (A3) and threat notes.
2. Keep PRs small, e.g. ≤ 400 changed lines excluding generated code (default; ADR).
3. CODEOWNERS with **2 human reviews** on `ledger`, `payments`, `checkout`, `inventory`, `auth`, `policy`, RLS migrations, `privacy` and `refunds` (T11).
4. A fresh-context review subagent checks the diff against the spec before human review.

**Agent sandbox**
5. Agents never hold production or staging credentials.
6. Deny rules cover `.env*`, `infra/prod`, `psql`/`DROP` against non-local DSNs, and `git push --force`.
7. A PreToolUse hook blocks edits to applied migrations, `ledger` posting immutability and CI config unless a human-tagged branch allows it.
8. Staging uses synthetic data only (T7), which removes the Replit failure class.

**Hooks**
9. A PostToolUse formatter and linter run on every edit.
10. A Stop hook runs `tsc --noEmit`, the affected tests and dependency-cruiser, and exits 2 on failure.
11. A pre-commit secret scan (gitleaks or similar) uses `onFailure: block`.

**CI (blocking)**
- **Types:** TS strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
- **ESLint:** `no-explicit-any`, `ban-ts-comment`, `no-non-null-assertion`, plus custom rules:
  - no `Number`/float arithmetic in the money path;
  - every repository list call requires `limit` and a cursor;
  - every mutating controller requires the idempotency decorator;
  - every route requires a policy guard.
- **Architecture:** dependency-cruiser fitness functions.
- **Code scanning:** Semgrep and CodeQL.
- **Secrets:** secret scanning plus push protection.
- **Dependencies:**
  - `pnpm install --frozen-lockfile`;
  - a **dependency allow-list**: any new package needs a human approval label plus checks on age, downloads and maintainer (anti-slopsquatting);
  - OSV audit;
  - a CycloneDX SBOM;
  - cosign signing and SLSA provenance.
- **Migrations:** migration linter, plus an automated **RLS test** that every tenant table has RLS enabled and that cross-tenant reads return zero rows (prevents a repeat of CVE-2025-48757).
- **Authorization:** a negative authorization test per endpoint (A2.10).
- **Test strength:** Stryker mutation ≥ 80% on critical modules, so that tests which test nothing fail. Also property tests, Pact contracts and k6 or latency budgets.
- **Queries:** an N+1 detector, i.e. a query-count assertion in integration tests.
- **Copy-lint:** fake social proof (A2.13).
- **Duplication:** a jscpd threshold (counters the GitClear finding).

### Gaps
- No controlled study shows which guardrail reduces AI defect rates most. The recommendations above rely on engineering consensus plus incident root causes.
- Anthropic's subagent and hook docs were fetched only via the best-practices page; check `hooks` and `sandboxing` reference pages for exact syntax at implementation time.

## Q4. Definition of Done and review checklist for AI-written code

### Takeaway
Add AI-specific items to master-prompt §P4. The reviewer must verify evidence (commands run and their output), not the agent's claims (per [Claude Code best practices](https://code.claude.com/docs/en/best-practices) and the METR perception gap, [METR 2025](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/)).

### Cited Findings
- Ask for evidence: the command and its output. — [best practices](https://code.claude.com/docs/en/best-practices)
- Generated RLS policies need manual review. — [Superblocks](https://www.superblocks.com/blog/lovable-rls-breach)

### Inferences: checklist (proposed)
- [ ] The PR links the spec and the plan; the diff matches the spec; no unrequested features.
- [ ] CI output is attached (typecheck, lint, tests, mutation score, dependency-cruiser).
- [ ] Every new endpoint has: authz guard + RLS + a negative test (404 for another tenant, 403 for the wrong role); Zod input and output; rate limit; idempotency if it writes; cursor pagination with a max page size.
- [ ] No new dependency without an allow-list approval; the package was verified to exist, is older than 90 days and has a real maintainer.
- [ ] No secrets, keys or DSNs in code or client bundles; all config comes from env or the secret manager.
- [ ] Money is `bigint` piastres; ledger entries balance; reversals are used, never updates.
- [ ] Tests assert behaviour (they would fail if the logic were deleted, which mutation testing proves), not mocks.
- [ ] No duplicated helpers; existing modules are reused (search before writing).
- [ ] Query count is bounded (no N+1); every list is limited.
- [ ] The migration is expand/contract and reversible; RLS is enabled on new tables.
- [ ] Logs carry no PII; `data_inventory.yaml` is updated.
- [ ] A human owner can explain every line in money, auth or PII paths (otherwise reject).

### Gaps
- No published industry-standard "AI code DoD" was found; this checklist is synthesized.
