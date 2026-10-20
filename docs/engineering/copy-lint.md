# Copy-lint (A2 rule 13)

Implements "CI lints UI copy for hard-coded numeric social proof" (master prompt A2.13, A2.18 forbidden list, CPL 181/2018).

Run: `node tooling/copy-lint/cli.mjs [--json] [--no-fail] [paths...]`. Tests: `node --test tooling/copy-lint/test/*.test.mjs`. CI: `.github/workflows/copy-lint.yml`. Offline; about 0.2 s for the whole repo. Uses the repo's `typescript` compiler API, so it needs `node_modules` (any `pnpm install`).

## What is scanned
`packages/i18n/src`, `apps/mobile/src`, `apps/seller-web/src`, `apps/admin-web/src` (`.ts`, `.tsx`). Skipped: tests, `test/`, `__tests__`, `fixtures`, `.d.ts`. Strings come from the TypeScript AST: string and no-substitution template literals, JSX text, and template expressions. Import specifiers, property keys, type literals, `===` comparands and non-copy JSX attributes (`testID`, `style`...) are ignored.

A `${n}` substitution is a placeholder, not a digit, so ``${n} people viewing`` (number from props or server) is not a finding. Hard-coded digits (Western, Eastern Arabic or Persian) are normalised before matching; Arabic tashkeel and alef/ya/ta-marbuta variants are folded.

## Rules
| Rule | Catches (EN and AR) |
|---|---|
| `social-proof-viewing` | "14 people viewing", "١٤ شخص يشاهدون" |
| `social-proof-bought` | "237 bought today", "تم بيع ٢٣٧ قطعة اليوم" |
| `fake-scarcity` | "Only 3 left", "متبقي ٣ قطع" |
| `fake-urgency` | "selling fast", "hurry", "يباع بسرعة", "سارع" (no digit needed) |
| `fake-countdown` | "ends in 2 hours", "02:59:59", "ينتهي خلال ٢ ساعة"; also `<Countdown*/Timer*>` or a decrementing `setInterval` in a file with no server-time reference (`serverTime`, `endsAt`, `expiresAt`...) |
| `fake-discount` | literal "70% off", "save 50%", "خصم ٧٠٪" (claims come only from the verified price, spec 9) |
| `confirm-shaming` | "No thanks, I hate saving", "لا شكرا، أنا أكره التوفير" |
| `prechecked-consent` | `granted/checked/value/defaultChecked: true` on a control or object whose name relates to consent, marketing, analytics, tracking, personalization, newsletter, cross-border, measurements; `useState(true)` for such names |
| `allow-invalid` | an allow comment without a server-derived justification |

## Allowlist
Genuine server-derived copy that must contain a literal can be allowed, with a justification naming the server source:

```ts
// copy-lint-allow(fake-scarcity): server-derived: GET /v1/products/{id} stock.remaining (shown only when <= 5)
```
The comment goes on the finding line or up to two lines above. Without `server-derived: <source>` the finding stays and an `allow-invalid` finding is added. File-level entries go in `tooling/copy-lint/allowlist.json` (`{file, rule, match?, justification}`) under the same justification rule. Prefer fixing the copy (use `{{count}}` interpolation fed by the API) over allowing it.

## Limits
Pattern based: novel phrasings are missed, and it cannot prove a templated number is truthful (that is a code-review and contract-test matter). Numeric words ("three people") are not detected. Arabic dialect coverage is a starting set; extend `tooling/copy-lint/rules.mjs` with fixtures when product copy review finds a miss.
