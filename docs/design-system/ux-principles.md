# UX principles: the 12 rules

One page. These keep the app feeling real and stop the design decaying as many people and agents edit it. Each rule has an enforcement; if a rule has none, add one before relying on it.

| # | Rule | How it is enforced |
|---|---|---|
| 1 | One primary action per screen. | Review checklist (`docs/design-system/screen-agent-brief.md`); kit exposes a single `Button variant="primary"` style. Not lintable yet. |
| 2 | No developer text in product screens (ids, enums, "TODO", raw keys). | `tooling/copy-lint` and i18n key-parity CI; Maestro flows assert localized strings. |
| 3 | Direction follows language (RTL mirrors, logical start/end). | `tooling/e2e` Arabic runs, Maestro `08-rtl-critical-path`, web overflow/RTL checks in `checkPage`. |
| 4 | Label above field, always visible. | Kit `Field` is the only text input; `DS-RN-COMPONENT` bans raw `TextInput` in screens. |
| 5 | Flat sections: no card-in-card, hairlines over boxes. | Kit layout components; visual regression (`docs/engineering/visual-regression.md`). |
| 6 | 44pt minimum touch targets. | Kit controls use `minTouchTarget`; `DS-RN-COMPONENT` bans raw `TouchableOpacity`/`Button`. |
| 7 | Honest empty, error and loading states (never blank, never fake). | Kit `EmptyState`/`ErrorState`; copy-lint blocks hard-coded social proof; Definition of Done P4. |
| 8 | Tokens only: colour, type, spacing, radius, motion. | `DS-COLOR`, `DS-FONT`, `DS-RADIUS`, `DS-MOTION-*` in `tooling/design/rules.mjs`; `packages/ui-tokens/src/drift.test.ts` (AA pairs, derived web CSS). |
| 9 | Copy in sentence case, plain words. | `tooling/copy-lint`; Arabic review pack. |
| 10 | Motion is subtle and respects Reduce Motion. | `DS-MOTION-ANIMATED`/`DS-MOTION-REANIMATED` force kit motion helpers; Playwright runs with reduced motion. |
| 11 | Arabic first: every string exists in AR before EN ships. | i18n parity CI (A2.15); Maestro AR env. |
| 12 | No fake data: stock, timers, reviews, discounts are real or absent. | `tooling/copy-lint`; price-integrity contract tests (spec section 9). |

## Guardrail mechanics
- Rules are ESLint `no-restricted-syntax` / `no-restricted-imports` entries in `tooling/design/rules.mjs`, wired through the root `eslint.config.mjs`. They apply to `apps/mobile/src` and `packages/ui-native/src`, excluding tests, `apps/mobile/src/art` and `packages/ui-tokens`.
- Existing violations are a baseline: `tooling/design/debt-baseline.json`, listed in `docs/plan/design-debt.md`. Those files are exempted per rule so the build passes.
- `node tooling/design/check-debt.mjs` fails when any file gains violations or a new file appears. After fixing a file run it with `--update` to shrink the baseline. Never raise it; never add `eslint-disable`.
- Kit components themselves (`packages/ui-native`) may use raw type sizes and motion; the import and typography rules target screens (`features`, `app`).
