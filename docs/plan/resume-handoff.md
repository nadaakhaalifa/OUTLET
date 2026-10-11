# Resume handoff (soft stop at ~03:45 Cairo, 2026-10-11; resume 05:51 Cairo)

Agents were stopped on purpose to avoid the session limit. Everything below is on disk but **not committed and not gate-green**. Last pushed commit before this work: `f0c998e` (Phase 2 specs, ADRs 0022-0027) plus ADR-0021. The money wave 4 and Phase 2 wave 5 code are uncommitted (about 190 changed or new files).

## Stopped mid-flight (re-verify their files, do not trust partial edits)

| Task | Paths | Risk |
|---|---|---|
| Phase 2 wave 5 (10 builders) | `apps/api/src/modules/{subscriptions,budget,stylist,llm-gateway,recommendations,history,rewards,drops,waiting-room,...}`, `packages/domain/src/{subscriptions,budget,stylist,recommendations,rewards,drops,hub,...}`, migrations 0036-0049 | Finished: rewards, recommendations + history. Others partial. Check on disk whether crawler, aramex-hub (courier-aramex, hub-consolidation, resale-lane) and sponsored-android (ads) exist. Any half-written migration must be completed or deleted |
| Checkout / store-credit fixer (F-1, F-4, F-11, F-13) | `modules/checkout`, `modules/store-credit`, `composition/checkout-adapters.ts`, `composition/credit-balances.ts` | Had only read files when stopped: assume NO fix landed |
| Refunds fixer (F-2, F-5, F-6, F-8) | `modules/refunds`, `composition/ledger-gateway.ts` | Same: assume nothing landed |
| Payouts / payments / ledger fixer (F-7, F-9, F-12) | `modules/payouts`, `payments`, `ledger` | Same |
| Wiring (I-2 relay, I-4 commerce terms) | `composition/money-wiring.ts`, `apps/api/src/zz-probe.test.ts` | Same |
| Gift-cards replacement | `modules/gift-cards`, `packages/domain/src/gift-cards`, migration 0037 | Partial or none |

## Order of work on resume

1. `git status`, then run typecheck, lint, tests, depcruise (Node 24), privacy, openapi, i18n. Record what is red. Known red: lint in drops / llm-gateway / stylist / hub / gift-cards (`no-useless-assignment`), `packages/domain/src/stylist/optimizer.ts` `Date.now`, k6 `_label`/`_e` unused, 4 `adversarial.wave4` cases awaiting the fixers.
2. Re-launch the four money fixers. The review is `docs/plan/phase-1-wave-4-money-review.md`; the merge gate is F-1, F-2, F-4, then a short Fable re-review of the diff.
3. Finish the partial Phase 2 modules (gift-cards, crawler, aramex-hub, sponsored-android, drops API), then one integration pass: domain namespace exports, `app.module.ts`, authz-matrix, OpenAPI, flag registry additions (`plus_sales`, `hub_consolidation`, `stylist_ml`, `gift_card_redemption`, search and courier fallbacks), ADR-0028 wording.
4. Commit in order: money wave 4 + fixes, then Phase 2 wave 5.
5. Then: mobile navigation wiring + testIDs + deep-link scheme rename (`outletnk` -> `zoutlet`), `GET /v1/me/orders` 404, privacy export schema drift, `Dockerfile` for `apps/api`, copy-lint and dora scripts in root `package.json`, Postgres 16 rerun with migrations 0035+.

## Decisions on record

F-1 money design approved with defaults (ADR-0021, with the honest deviations section). Paymob chosen, not contracted: fakes only. Web apps in scope (scaffolded: `apps/seller-web`, `apps/admin-web`). The owner said to continue automatically through Phase 2.

## Operating notes

Keep concurrent agents to about 6. Replace any agent idle for over 15 minutes (API timeouts happened). Do not run `pkill -f` with a pattern that appears in your own command line. Stray Stryker processes can exhaust the process table: kill them before launching a wave.
