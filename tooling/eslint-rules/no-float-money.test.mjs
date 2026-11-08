import { RuleTester } from "eslint";
import { afterAll, describe, it } from "vitest";
import tseslint from "typescript-eslint";
import rule from "./no-float-money.mjs";

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;

new RuleTester({ languageOptions: { ecmaVersion: 2022, sourceType: "module" } }).run("no-float-money", rule, {
  valid: [
    "const total = amountMinor + feeMinor;",
    "const n = count * 2;",
    "const t = a.amountMinor - b.amountMinor;",
    "const x = rate / 100;",
    "const v = minorVersion * 2;",
    "const v = row['count'] / 2;",
    "const v = Number(count);",
    "const v = Math.max(a, b);",
  ],
  invalid: [
    { code: "const t = row?.price / 2;", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = row['price'] / 2;", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = amountMinor * 2;", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = priceMinor / 2;", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = minorUnits * 2;", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = Number(amount);", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = parseFloat(price);", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = parseInt(money);", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = Math.round(total.amountMinor);", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = price * 1.14;", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = total.amountMinor / 3;", errors: [{ messageId: "floatMoney" }] },
    { code: "const t = 0.5 * moneyValue;", errors: [{ messageId: "floatMoney" }] },
    { code: "let a = 1; a *= 2; let unitPrice = 1; unitPrice *= 1.1;", errors: [{ messageId: "floatMoney" }] },
  ],
});

new RuleTester({ languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: "module" } }).run(
  "no-float-money (ts)",
  rule,
  {
    valid: ["const v = (count satisfies number) * 2;"],
    invalid: [
      { code: "const t = (price satisfies number) / 2;", errors: [{ messageId: "floatMoney" }] },
      { code: "const t = (row.amountMinor as number) * 2;", errors: [{ messageId: "floatMoney" }] },
    ],
  },
);
