## What and why

<!-- One paragraph. Link the spec section (docs/haul-master-prompt-v3.md section, docs/specs/*.md) and the ADR if any. -->

Spec link:
Related ADR / open question:

## Type of change

- [ ] Feature
- [ ] Fix
- [ ] Refactor (no behaviour change)
- [ ] Infra / CI
- [ ] Docs / ADR

## Touches money, ledger, pricing, refunds, wallet, auth or personal data?

- [ ] No
- [ ] Yes: this PR needs two approving reviews from CODEOWNERS (money and security)

## Threat notes

<!-- STRIDE in 3 lines: what can an attacker, a rogue seller, or a retrying client do with this change? Abuse cases, idempotency, authorization on every new endpoint. "None, because ..." is acceptable. -->

## Screenshots (UI changes)

|            | Light | Dark |
|------------|-------|------|
| Arabic (RTL) |       |      |
| English (LTR) |      |      |

## Checklist

- [ ] Typecheck, lint, tests pass locally (`pnpm typecheck && pnpm lint && pnpm test`)
- [ ] `pnpm depcruise` and `pnpm i18n-check` pass
- [ ] No `any`, no `@ts-ignore`, no non-null assertion outside tests; Zod at every new boundary
- [ ] Money is integer piastres (bigint); every money movement posts balanced ledger entries
- [ ] New state changes go through an explicit state machine and carry an idempotency key
- [ ] Authorization tests added for every new endpoint
- [ ] Arabic strings added alongside English; RTL checked
- [ ] No fake stock, timers, reviews or discounts; fixtures are labelled as development fixtures
- [ ] No real personal data in code, fixtures, logs or screenshots
- [ ] Anything legal, regulatory or provider-specific is tagged `VERIFY BEFORE LAUNCH` and added to docs/compliance/verify-register.md
- [ ] Conventional commit title (feat, fix, chore, docs, refactor, test, ci)
