import { describe, expect, it } from "vitest";
import { accounts } from "../ledger";
import {
  ACCOUNT_TYPES,
  chart,
  describeAccount,
  type AccountTypeName,
} from "./accounts";
import { InvalidAccountError } from "./errors";

describe("chart of accounts", () => {
  it("covers every account type listed in spec T4", () => {
    const t4: AccountTypeName[] = [
      "psp_clearing",
      "cod_clearing",
      "seller_payable",
      "platform_commission",
      "platform_vat_output",
      "shipping_revenue",
      "promo_expense_platform",
      "promo_receivable_seller",
      "store_credit",
      "gift_card_liability",
      "refund_reserve",
      "bnpl_clearing",
      "plus_revenue",
      "deferred_plus_revenue",
    ];
    for (const name of t4) {
      expect(ACCOUNT_TYPES[name].inSpecT4).toBe(true);
    }
    const inChart = Object.values(ACCOUNT_TYPES).filter((d) => d.inSpecT4).map((d) => d.type);
    expect(inChart.sort()).toEqual([...t4].sort());
  });

  it("gives every type a normal balance consistent with its category", () => {
    for (const def of Object.values(ACCOUNT_TYPES)) {
      const expected = def.category === "asset" || def.category === "expense" ? "debit" : "credit";
      expect(def.normalBalance, def.type).toBe(expected);
      expect(def.lifecycle.length).toBeGreaterThan(0);
    }
  });

  it("produces ids compatible with the ledger helpers", () => {
    expect(chart.pspClearing("p")).toBe(accounts.pspClearing("p"));
    expect(chart.codClearing("c")).toBe(accounts.codClearing("c"));
    expect(chart.bnplClearing("b")).toBe(accounts.bnplClearing("b"));
    expect(chart.sellerPayable("s")).toBe(accounts.sellerPayable("s"));
    expect(chart.storeCredit("u", { kind: "goodwill" })).toBe(accounts.storeCredit("u", "goodwill"));
    expect(chart.platformCommission).toBe(accounts.platformCommission);
    expect(chart.giftCardLiability).toBe(accounts.giftCardLiability);
  });

  it("round-trips ids through describeAccount, including gift card sub-balances", () => {
    expect(describeAccount(chart.sellerPayable("s1")).definition.type).toBe("seller_payable");
    const gc = describeAccount(chart.storeCredit("u1", { kind: "gift_card", cardId: "gc9" }));
    expect(gc.definition.type).toBe("store_credit");
    expect(gc.parameters).toEqual(["u1", "gift_card:gc9"]);
    expect(describeAccount(chart.platformVatOutput).parameters).toEqual([]);
  });

  it("rejects unknown types, missing parameters and unsafe segments", () => {
    expect(() => describeAccount("mystery:x")).toThrow(InvalidAccountError);
    expect(() => describeAccount("seller_payable")).toThrow(InvalidAccountError);
    expect(() => describeAccount("platform_commission:extra")).toThrow(InvalidAccountError);
    expect(() => chart.sellerPayable("a:b")).toThrow(InvalidAccountError);
    expect(() => chart.sellerPayable("")).toThrow(InvalidAccountError);
    expect(() => describeAccount("constructor")).toThrow(InvalidAccountError);
  });
});
