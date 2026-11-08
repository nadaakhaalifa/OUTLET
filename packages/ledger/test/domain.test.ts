import fc from "fast-check";
import { money } from "@outlet/money";
import { describe, expect, it } from "vitest";
import { ACCOUNT_TYPES, ACCOUNT_TYPE_NAMES, LedgerError, accountCode, isAccountType, isEntryKind, parseAccountCode, validateDraft } from "../src/index.js";
import type { JournalEntryDraft } from "../src/index.js";
import { acc, cr, dr, draftOf } from "./fixtures.js";

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    if (e instanceof LedgerError) return e.code;
    throw e;
  }
  return "NO_ERROR";
};

describe("account codes", () => {
  it("builds and parses every chart shape", () => {
    expect(accountCode({ type: "psp_clearing", market: "EG", currency: "EGP", owner: "paymob" })).toBe("psp_clearing:EG:EGP:paymob");
    expect(accountCode({ type: "platform_vat_output", market: "EG", currency: "EGP" })).toBe("platform_vat_output:EG:EGP");
    expect(accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: "usr_1", sub: "refund_credit" })).toBe(
      "store_credit:EG:EGP:usr_1:refund_credit",
    );
    expect(parseAccountCode("store_credit:EG:EGP:usr_1:refund_credit")).toMatchObject({ type: "store_credit", owner: "usr_1", sub: "refund_credit" });
    expect(parseAccountCode("commission_revenue:EG:EGP")).toEqual({ type: "commission_revenue", market: "EG", currency: "EGP", code: "commission_revenue:EG:EGP" });
  });

  it("round-trips every account type", () => {
    for (const type of ACCOUNT_TYPE_NAMES) {
      const spec = ACCOUNT_TYPES[type];
      const built = accountCode({
        type,
        market: "EG",
        currency: "EGP",
        ...(spec.owner !== "none" ? { owner: "o1" } : {}),
        ...(spec.sub ? { sub: "goodwill" } : {}),
      });
      expect(parseAccountCode(built).code).toBe(built);
      expect(isAccountType(type)).toBe(true);
    }
  });

  it.each([
    ["too few segments", "psp_clearing:EG"],
    ["too many segments", "store_credit:EG:EGP:u:a:b"],
    ["unknown type", "nonsense:EG:EGP"],
    ["bad market", "psp_clearing:egypt:EGP:paymob"],
    ["unknown currency", "psp_clearing:EG:XXX:paymob"],
    ["missing required owner", "psp_clearing:EG:EGP"],
    ["owner on ownerless type", "commission_revenue:EG:EGP:x"],
    ["missing sub", "store_credit:EG:EGP:u1"],
    ["sub on non store_credit", "seller_pending:EG:EGP:A:sub"],
    ["empty segment", "psp_clearing:EG:EGP:"],
    ["illegal character", "psp_clearing:EG:EGP:pay mob"],
    ["empty", ""],
  ])("rejects %s", (_n, c) => {
    expect(code(() => parseAccountCode(c))).toBe("LEDGER_INVALID_ACCOUNT_CODE");
  });

  it("rejects reserved names (spec 3.5)", () => {
    expect(code(() => parseAccountCode("gift_card_liability:EG:EGP"))).toBe("LEDGER_RESERVED_ACCOUNT");
    expect(code(() => parseAccountCode("fx_conversion:EG:EGP"))).toBe("LEDGER_RESERVED_ACCOUNT");
  });

  it("builder rejects bad parts", () => {
    expect(code(() => accountCode({ type: "psp_clearing", market: "EG", currency: "EGP" }))).toBe("LEDGER_INVALID_ACCOUNT_CODE");
    expect(code(() => accountCode({ type: "commission_revenue", market: "EG", currency: "EGP", owner: "x" }))).toBe("LEDGER_INVALID_ACCOUNT_CODE");
    expect(code(() => accountCode({ type: "store_credit", market: "EG", currency: "EGP", owner: "u" }))).toBe("LEDGER_INVALID_ACCOUNT_CODE");
    expect(code(() => accountCode({ type: "psp_clearing", market: "EG", currency: "EGP", owner: "a:b" }))).toBe("LEDGER_INVALID_ACCOUNT_CODE");
    expect(code(() => accountCode({ type: "nope" as never, market: "EG", currency: "EGP" }))).toBe("LEDGER_INVALID_ACCOUNT_CODE");
  });

  it("knows the entry kinds", () => {
    expect(isEntryKind("reversal")).toBe(true);
    expect(isEntryKind("made_up")).toBe(false);
  });
});

const base = draftOf({
  kind: "order_recognised",
  key: "k1",
  lines: [dr(acc("psp_clearing", "paymob"), 100n), cr(acc("seller_pending", "A"), 100n)],
});

describe("validateDraft", () => {
  it("accepts a balanced draft and parses accounts", () => {
    const v = validateDraft(base);
    expect(v.postings.map((p) => p.account.type)).toEqual(["psp_clearing", "seller_pending"]);
  });

  const mutate = (patch: Partial<JournalEntryDraft>): JournalEntryDraft => ({ ...base, ...patch });
  it.each<[string, JournalEntryDraft, string]>([
    ["unknown kind", mutate({ kind: "nope" }), "LEDGER_INVALID_KIND"],
    ["empty key", mutate({ idempotencyKey: "" }), "LEDGER_INVALID_DRAFT"],
    ["long key", mutate({ idempotencyKey: "k".repeat(256) }), "LEDGER_INVALID_DRAFT"],
    ["empty market", mutate({ marketId: "" }), "LEDGER_INVALID_DRAFT"],
    ["empty ref type", mutate({ ref: { type: "", id: "x" } }), "LEDGER_INVALID_DRAFT"],
    ["empty ref id", mutate({ ref: { type: "x", id: "" } }), "LEDGER_INVALID_DRAFT"],
    ["invalid date", mutate({ occurredAt: new Date(Number.NaN) }), "LEDGER_INVALID_DRAFT"],
    ["one posting", mutate({ postings: base.postings.slice(0, 1) }), "LEDGER_TOO_FEW_POSTINGS"],
    ["no postings", mutate({ postings: [] }), "LEDGER_TOO_FEW_POSTINGS"],
    [
      "too many postings",
      mutate({ postings: Array.from({ length: 201 }, (_v, i) => ({ accountCode: acc("psp_clearing", "paymob"), amount: money(i % 2 === 0 ? 1n : -1n, "EGP") })) }),
      "LEDGER_INVALID_DRAFT",
    ],
    [
      "unbalanced",
      mutate({ postings: [base.postings[0]!, { accountCode: acc("seller_pending", "A"), amount: money(-99n, "EGP") }] }),
      "LEDGER_UNBALANCED",
    ],
    [
      "zero posting",
      mutate({ postings: [...base.postings, { accountCode: acc("commission_revenue"), amount: money(0n, "EGP") }] }),
      "LEDGER_ZERO_POSTING",
    ],
    [
      "mixed market",
      mutate({ postings: [base.postings[0]!, { accountCode: "seller_pending:SA:EGP:A", amount: money(-100n, "EGP") }] }),
      "LEDGER_MARKET_MISMATCH",
    ],
    [
      "account currency differs from posting currency",
      mutate({ postings: [base.postings[0]!, { accountCode: acc("seller_pending", "A"), amount: money(-100n, "SAR") }] }),
      "LEDGER_CURRENCY_MISMATCH",
    ],
    [
      "beyond BIGINT",
      mutate({ postings: [{ accountCode: acc("psp_clearing", "paymob"), amount: money(2n ** 63n, "EGP") }, { accountCode: acc("seller_pending", "A"), amount: money(-(2n ** 63n), "EGP") }] }),
      "LEDGER_INVALID_DRAFT",
    ],
    [
      "reserved account",
      mutate({ postings: [base.postings[0]!, { accountCode: "gift_card_liability:EG:EGP", amount: money(-100n, "EGP") }] }),
      "LEDGER_RESERVED_ACCOUNT",
    ],
  ])("rejects %s", (_n, draft, expected) => {
    expect(code(() => validateDraft(draft))).toBe(expected);
  });

  it("property: accepted iff every currency sums to zero (1000 runs)", () => {
    const pool = [acc("psp_clearing", "paymob"), acc("seller_pending", "A"), acc("commission_revenue"), acc("platform_vat_output")];
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 0, max: pool.length - 1 }), fc.bigInt({ min: -1_000_000n, max: 1_000_000n }).filter((n) => n !== 0n)), { minLength: 2, maxLength: 8 }),
        (rows) => {
          const postings = rows.map(([i, n]) => ({ accountCode: pool[i] ?? "", amount: money(n, "EGP") }));
          const sum = rows.reduce((a, [, n]) => a + n, 0n);
          const outcome = code(() => validateDraft({ ...base, postings }));
          expect(outcome).toBe(sum === 0n ? "NO_ERROR" : "LEDGER_UNBALANCED");
        },
      ),
      { numRuns: 1000 },
    );
  });

  it("zero-sum is per currency, not overall", () => {
    const d = mutate({
      postings: [
        { accountCode: acc("psp_clearing", "paymob"), amount: money(100n, "EGP") },
        { accountCode: "psp_clearing:EG:SAR:paymob", amount: money(-100n, "SAR") },
      ],
    });
    expect(code(() => validateDraft(d))).toBe("LEDGER_UNBALANCED");
  });
});
