## What and why
<!-- One concern per PR, at most ~400 changed lines excluding generated files. Link the spec section. -->

## Evidence
<!-- Paste exact commands and their output: typecheck, lint, depcruise, tests, query plans, benchmarks. -->

## Definition of Done
- [ ] Spec section, threat notes and an ADR if a decision was made
- [ ] Types plus Zod; no lint, typecheck or dependency-cruiser errors
- [ ] Unit, integration and E2E tests, the negative authZ test, the RLS test and the query-count test all green; mutation threshold met where required
- [ ] `EXPLAIN` plans for new queries; indexes justified; pagination keyset
- [ ] Performance budget met, with numbers recorded
- [ ] AR/EN + RTL, light/dark, all states, a11y checked
- [ ] Analytics events typed and consent-aware; logs, metrics and traces; SLO and alert defined
- [ ] Security, privacy and SEO checklist items for the touched area ticked; `data_inventory.yaml` updated
- [ ] Feature flag and kill switch; runbook and docs updated
- [ ] Command output pasted in the PR; `needs-human` label on two-key areas
- [ ] **Build Tracker updated**

## needs-human
Code in `ledger`, `payments`, `checkout`, `inventory`, `auth`, `policy`/RLS, `privacy`, `pricing-integrity`, `payouts`, and any change under `.github/workflows/**`, must carry the `needs-human` label. It needs (a) a fresh-context reviewer check of the diff against the spec and (b) explicit owner approval before merge.
