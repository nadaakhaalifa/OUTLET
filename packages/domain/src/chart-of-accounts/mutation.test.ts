import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createJournalEntry, type JournalEntry } from "../ledger";
import { money, type Money } from "../money";
import {
  ACCOUNT_TYPES,
  chart,
  derivedBalance,
  describeAccount,
  subBalanceKey,
  type StoreCreditSub,
} from "./accounts";
import {
  allocateVoucher,
  clearingSettled,
  commissionOf,
  commissionVatOf,
  giftCardRedeemed,
  giftCardSold,
  orderRecognised,
  planPlusRecognition,
  plusCharged,
  plusRevenueRecognised,
  refundIssued,
  sellerPayout,
  sellerPromoNetted,
  storeCreditExpired,
  storeCreditGranted,
  tenderAccount,
  vatIncluded,
  type EntryMeta,
  type Tender,
} from "./builders";
import { InsufficientCreditError, InvalidAccountError, InvalidChartInputError, TenderMismatchError } from "./errors";
import { planStoreCreditSpend, type SubBalanceState } from "./spend";

/** Mutation-killing tests for the chart of accounts: exact postings, messages and boundaries. */

const EXPECTED_ACCOUNT_TYPES = {
  "psp_clearing": {
    "type": "psp_clearing",
    "category": "asset",
    "normalBalance": "debit",
    "owner": "psp",
    "parameters": [
      "psp"
    ],
    "purpose": "Money the PSP holds for us: card and wallet captures not yet settled to the bank.",
    "lifecycle": "Opened when a PSP integration is enabled. Never closed. Drains to bank_settlement on each settlement file.",
    "reconciledAgainst": "PSP settlement files (nightly)",
    "inSpecT4": true,
    "status": "active"
  },
  "cod_clearing": {
    "type": "cod_clearing",
    "category": "asset",
    "normalBalance": "debit",
    "owner": "courier",
    "parameters": [
      "courier"
    ],
    "purpose": "Cash the courier has collected on delivery and still owes us.",
    "lifecycle": "Opened per courier contract. Debited at delivery, credited at remittance. Aging above 3 days escalates to Finance.",
    "reconciledAgainst": "Courier COD remittance reports",
    "inSpecT4": true,
    "status": "active"
  },
  "bnpl_clearing": {
    "type": "bnpl_clearing",
    "category": "asset",
    "normalBalance": "debit",
    "owner": "bnpl_provider",
    "parameters": [
      "provider"
    ],
    "purpose": "What the BNPL provider owes us for approved orders, before its fee and settlement.",
    "lifecycle": "Opened per provider. Debited when the provider approves an order, credited at settlement or on a loan cancellation.",
    "reconciledAgainst": "BNPL provider settlement statements",
    "inSpecT4": true,
    "status": "active"
  },
  "bank_settlement": {
    "type": "bank_settlement",
    "category": "asset",
    "normalBalance": "debit",
    "owner": "bank",
    "parameters": [
      "account"
    ],
    "purpose": "Cash that has actually arrived in, or left, a bank account that settlements and payouts run through.",
    "lifecycle": "One per bank account actually used. Opened when the flow of funds is decided. Never closed.",
    "reconciledAgainst": "Bank statements",
    "inSpecT4": false,
    "status": "active",
    "verify": "VERIFY BEFORE LAUNCH: not in spec T4. Whether Z-OUTLET ever holds funds in its own account depends on open question 4 (flow of funds, CBE and PSP licensing)."
  },
  "seller_payable": {
    "type": "seller_payable",
    "category": "liability",
    "normalBalance": "credit",
    "owner": "seller",
    "parameters": [
      "store"
    ],
    "purpose": "What we owe a seller for goods sold, net of commission and VAT on commission. Negative means the seller owes us.",
    "lifecycle": "Opened with the seller's first order. Credited per order, debited by payouts, refunds and netting. Closed only at seller offboarding when it is zero.",
    "reconciledAgainst": "Payout batches and seller statements",
    "inSpecT4": true,
    "status": "active"
  },
  "store_credit": {
    "type": "store_credit",
    "category": "liability",
    "normalBalance": "credit",
    "owner": "shopper",
    "parameters": [
      "user",
      "sub_balance"
    ],
    "purpose": "Closed-loop HAUL credit owed to a shopper, one account per sub-balance.",
    "lifecycle": "Opened on first grant. Sub-balances: refund_credit (no expiry), gift_card:{cardId}, cashback_coins (12 months), referral_credit (6 months), goodwill (90 days). Never negative.",
    "reconciledAgainst": "Cached wallet projection (nightly)",
    "inSpecT4": true,
    "status": "active"
  },
  "gift_card_liability": {
    "type": "gift_card_liability",
    "category": "liability",
    "normalBalance": "credit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Unredeemed gift-card value that has been sold.",
    "lifecycle": "Credited at sale, debited at redemption into a gift_card sub-balance. Breakage on expiry is not modelled.",
    "reconciledAgainst": "Gift-card table (issued minus redeemed)",
    "inSpecT4": true,
    "status": "active",
    "verify": "VERIFY BEFORE LAUNCH: VAT point for gift cards (sale or redemption) and expiry or breakage treatment."
  },
  "refund_reserve": {
    "type": "refund_reserve",
    "category": "liability",
    "normalBalance": "credit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Reserved for holding back value against expected refunds.",
    "lifecycle": "Reserved. No builder posts to it in Phase 1. Must stay at zero until a spec defines its use.",
    "inSpecT4": true,
    "status": "reserved"
  },
  "deferred_plus_revenue": {
    "type": "deferred_plus_revenue",
    "category": "liability",
    "normalBalance": "credit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Plus subscription fees collected for periods not yet served.",
    "lifecycle": "Credited at charge (net of VAT), debited each period as revenue is recognised. Zero after the last period.",
    "inSpecT4": true,
    "status": "active"
  },
  "platform_vat_output": {
    "type": "platform_vat_output",
    "category": "liability",
    "normalBalance": "credit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Output VAT owed on Z-OUTLET's own supplies: commission, shipping fees and Plus.",
    "lifecycle": "Credited when a taxable supply is invoiced. Cleared by the periodic VAT return, outside this ledger for now.",
    "reconciledAgainst": "ETA e-invoice and e-receipt submissions",
    "inSpecT4": true,
    "status": "active",
    "verify": "VERIFY BEFORE LAUNCH: VAT base when the platform funds a discount, and VAT on coins, vouchers and gift cards."
  },
  "platform_commission": {
    "type": "platform_commission",
    "category": "revenue",
    "normalBalance": "credit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Commission earned from sellers, net of VAT.",
    "lifecycle": "Credited when an order is recognised, debited on refunds. Closed to retained earnings at period end.",
    "inSpecT4": true,
    "status": "active"
  },
  "shipping_revenue": {
    "type": "shipping_revenue",
    "category": "revenue",
    "normalBalance": "credit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Delivery fees charged to shoppers, net of VAT.",
    "lifecycle": "Credited with the order, debited when a fee is refunded.",
    "inSpecT4": true,
    "status": "active"
  },
  "plus_revenue": {
    "type": "plus_revenue",
    "category": "revenue",
    "normalBalance": "credit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Plus subscription revenue recognised for periods served.",
    "lifecycle": "Credited from deferred_plus_revenue once per period.",
    "inSpecT4": true,
    "status": "active"
  },
  "promo_expense_platform": {
    "type": "promo_expense_platform",
    "category": "expense",
    "normalBalance": "debit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Cost of promotions the platform funds: vouchers, coins, referral credit and goodwill.",
    "lifecycle": "Debited when a platform-funded discount is applied or credit is granted. Credited when coins expire or the discounted line is refunded.",
    "inSpecT4": true,
    "status": "active",
    "verify": "VERIFY BEFORE LAUNCH: whether coins and vouchers are an expense or a reduction of revenue, and the VAT effect."
  },
  "promo_receivable_seller": {
    "type": "promo_receivable_seller",
    "category": "asset",
    "normalBalance": "debit",
    "owner": "seller",
    "parameters": [
      "store"
    ],
    "purpose": "Discount value Z-OUTLET fronted to shoppers that a seller agreed to fund, recovered by netting from seller_payable.",
    "lifecycle": "Debited when a seller-funded discount is applied, credited when netted against the seller payable.",
    "inSpecT4": true,
    "status": "active",
    "verify": "Parameterised by store here, while T4 lists it without a parameter, so that netting is per seller."
  },
  "provider_fee_expense": {
    "type": "provider_fee_expense",
    "category": "expense",
    "normalBalance": "debit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Fees deducted by PSPs and BNPL providers at settlement.",
    "lifecycle": "Debited at settlement.",
    "inSpecT4": false,
    "status": "active",
    "verify": "VERIFY BEFORE LAUNCH: who bears provider fees (platform or seller) and their VAT treatment. Not in spec T4."
  },
  "courier_fee_expense": {
    "type": "courier_fee_expense",
    "category": "expense",
    "normalBalance": "debit",
    "owner": "platform",
    "parameters": [],
    "purpose": "COD handling fees a courier withholds from a remittance.",
    "lifecycle": "Debited at remittance.",
    "inSpecT4": false,
    "status": "active",
    "verify": "VERIFY BEFORE LAUNCH: courier contract terms. Not in spec T4."
  },
  "creator_payable": {
    "type": "creator_payable",
    "category": "liability",
    "normalBalance": "credit",
    "owner": "shopper",
    "parameters": [
      "creator"
    ],
    "purpose": "Affiliate commission owed to a creator (keyed by the creator's user id) after the return window. Negative means the creator owes us after a clawback.",
    "lifecycle": "Credited when a commission accrues, debited by a payout or a clawback. A negative balance is reported explicitly and netted from the next payout, never hidden.",
    "reconciledAgainst": "Commissions table (accrued minus clawed back minus paid) and creator payout batches",
    "inSpecT4": false,
    "status": "active",
    "verify": "VERIFY BEFORE LAUNCH: creator withholding and VAT treatment (VR-P3-03), and whether a creator payable may sit on the ledger before payouts are licensed (ADR-0037). Not in spec T4."
  },
  "creator_commission_expense": {
    "type": "creator_commission_expense",
    "category": "expense",
    "normalBalance": "debit",
    "owner": "platform",
    "parameters": [],
    "purpose": "Cost of affiliate commission the platform funds.",
    "lifecycle": "Debited when a commission accrues, credited by a clawback. Closed to retained earnings at period end.",
    "inSpecT4": false,
    "status": "active",
    "verify": "VERIFY BEFORE LAUNCH: VAT base for platform-funded commission (VR-P3-03). Not in spec T4."
  }
};

const at = new Date("2026-10-10T08:00:00Z");
const META: EntryMeta = { id: "e-1", idempotencyKey: "key-1", occurredAt: at, ref: { type: "order_group", id: "og-1" } };
const m = (n: bigint): Money => money(n);
const view = (e: JournalEntry): [string, bigint][] => e.postings.map((p) => [p.account, p.amount.amount]);

describe("ACCOUNT_TYPES is pinned exactly", () => {
  it("matches the reviewed chart, including documentation fields", () => {
    expect(JSON.parse(JSON.stringify(ACCOUNT_TYPES))).toEqual(EXPECTED_ACCOUNT_TYPES);
    expect(Object.keys(ACCOUNT_TYPES)).toEqual(Object.keys(EXPECTED_ACCOUNT_TYPES));
  });

  it("keys match the type field of every definition", () => {
    for (const [key, def] of Object.entries(ACCOUNT_TYPES)) expect(def.type).toBe(key);
  });
});

describe("chart id constructors", () => {
  it("build ids in the T4 format", () => {
    expect(chart.pspClearing("kashier")).toBe("psp_clearing:kashier");
    expect(chart.codClearing("bosta")).toBe("cod_clearing:bosta");
    expect(chart.bnplClearing("valu")).toBe("bnpl_clearing:valu");
    expect(chart.bankSettlement("cib-1")).toBe("bank_settlement:cib-1");
    expect(chart.sellerPayable("store_9")).toBe("seller_payable:store_9");
    expect(chart.promoReceivableSeller("s1")).toBe("promo_receivable_seller:s1");
    expect(chart.storeCredit("u1", { kind: "goodwill" })).toBe("store_credit:u1:goodwill");
    expect(chart.storeCredit("u1", { kind: "gift_card", cardId: "c1" })).toBe("store_credit:u1:gift_card:c1");
  });

  it("exposes the singleton ids", () => {
    expect(chart.giftCardLiability).toBe("gift_card_liability");
    expect(chart.refundReserve).toBe("refund_reserve");
    expect(chart.deferredPlusRevenue).toBe("deferred_plus_revenue");
    expect(chart.platformVatOutput).toBe("platform_vat_output");
    expect(chart.platformCommission).toBe("platform_commission");
    expect(chart.shippingRevenue).toBe("shipping_revenue");
    expect(chart.plusRevenue).toBe("plus_revenue");
    expect(chart.promoExpensePlatform).toBe("promo_expense_platform");
    expect(chart.providerFeeExpense).toBe("provider_fee_expense");
    expect(chart.courierFeeExpense).toBe("courier_fee_expense");
  });

  it("accepts letters, digits, underscore and hyphen", () => {
    expect(chart.pspClearing("Az09_-")).toBe("psp_clearing:Az09_-");
  });

  it("rejects anything else with a precise message", () => {
    const bad = ["", " ", "a b", "a:b", "a.b", "a/b", "a\n", "\na", "é", "a;b", "-a ", "x\u0000"];
    for (const v of bad) {
      expect(() => chart.pspClearing(v)).toThrow(InvalidAccountError);
      expect(() => chart.pspClearing(v)).toThrow(`psp must match ^[A-Za-z0-9_-]+$, got "${v}"`);
    }
    expect(() => chart.codClearing("a b")).toThrow('courier must match ^[A-Za-z0-9_-]+$, got "a b"');
    expect(() => chart.bnplClearing("a b")).toThrow('provider must match');
    expect(() => chart.bankSettlement("a b")).toThrow('account must match');
    expect(() => chart.sellerPayable("a b")).toThrow('store must match');
    expect(() => chart.promoReceivableSeller("a b")).toThrow('store must match');
    expect(() => chart.storeCredit("a b", { kind: "goodwill" })).toThrow('user must match');
    expect(() => chart.storeCredit("u", { kind: "gift_card", cardId: "x y" })).toThrow('cardId must match');
  });
});

describe("subBalanceKey", () => {
  it("uses the kind, and kind:cardId for gift cards", () => {
    const kinds: StoreCreditSub[] = [
      { kind: "refund_credit" },
      { kind: "cashback_coins" },
      { kind: "referral_credit" },
      { kind: "goodwill" },
    ];
    for (const k of kinds) expect(subBalanceKey(k)).toBe(k.kind);
    expect(subBalanceKey({ kind: "gift_card", cardId: "abc-1" })).toBe("gift_card:abc-1");
    expect(() => subBalanceKey({ kind: "gift_card", cardId: "" })).toThrow(InvalidAccountError);
  });
});

describe("describeAccount", () => {
  it("resolves every type with its parameters", () => {
    const cases: [string, string, string[]][] = [
      ["psp_clearing:kashier", "psp_clearing", ["kashier"]],
      ["cod_clearing:bosta", "cod_clearing", ["bosta"]],
      ["bnpl_clearing:valu", "bnpl_clearing", ["valu"]],
      ["bank_settlement:cib", "bank_settlement", ["cib"]],
      ["seller_payable:s1", "seller_payable", ["s1"]],
      ["promo_receivable_seller:s1", "promo_receivable_seller", ["s1"]],
      ["store_credit:u1:goodwill", "store_credit", ["u1", "goodwill"]],
      ["store_credit:u1:gift_card:c9", "store_credit", ["u1", "gift_card:c9"]],
      ["gift_card_liability", "gift_card_liability", []],
      ["refund_reserve", "refund_reserve", []],
      ["deferred_plus_revenue", "deferred_plus_revenue", []],
      ["platform_vat_output", "platform_vat_output", []],
      ["platform_commission", "platform_commission", []],
      ["shipping_revenue", "shipping_revenue", []],
      ["plus_revenue", "plus_revenue", []],
      ["promo_expense_platform", "promo_expense_platform", []],
      ["provider_fee_expense", "provider_fee_expense", []],
      ["courier_fee_expense", "courier_fee_expense", []],
    ];
    for (const [id, type, params] of cases) {
      const d = describeAccount(id);
      expect(d.definition.type).toBe(type);
      expect(d.parameters).toEqual(params);
    }
  });

  it("rejects unknown types, including inherited object keys", () => {
    for (const id of ["", "nope", "nope:x", "toString", "constructor:x", "__proto__", "hasOwnProperty"]) {
      expect(() => describeAccount(id)).toThrow(InvalidAccountError);
      expect(() => describeAccount(id)).toThrow(`unknown account type in "${id}"`);
    }
  });

  it("checks parameter counts and empty parameters", () => {
    expect(() => describeAccount("psp_clearing")).toThrow('account "psp_clearing" needs 1 parameter(s)');
    expect(() => describeAccount("psp_clearing:")).toThrow('account "psp_clearing:" needs 1 parameter(s)');
    expect(() => describeAccount("psp_clearing:a:b")).toThrow('needs 1 parameter(s)');
    expect(() => describeAccount("platform_commission:x")).toThrow('account "platform_commission:x" needs 0 parameter(s)');
    expect(() => describeAccount("store_credit:u1")).toThrow('needs 2 parameter(s)');
    expect(() => describeAccount("store_credit:u1:")).toThrow('needs 2 parameter(s)');
    expect(() => describeAccount("store_credit::goodwill")).toThrow('needs 2 parameter(s)');
    expect(() => describeAccount("store_credit")).toThrow('needs 2 parameter(s)');
  });
});

describe("derivedBalance", () => {
  const entry = createJournalEntry({
    id: "x",
    kind: "t",
    idempotencyKey: "k",
    occurredAt: at,
    ref: { type: "t", id: "1" },
    postings: [
      { account: "psp_clearing:p", amount: m(500n) },
      { account: "seller_payable:s", amount: m(-500n) },
    ],
  });

  it("is positive for a debit-normal account holding debits and credit-normal holding credits", () => {
    expect(derivedBalance("psp_clearing:p", [entry]).amount).toBe(500n);
    expect(derivedBalance("seller_payable:s", [entry]).amount).toBe(500n);
    expect(derivedBalance("seller_payable:other", [entry]).amount).toBe(0n);
    expect(derivedBalance("psp_clearing:p", []).amount).toBe(0n);
  });

  it("rejects ids outside the chart", () => {
    expect(() => derivedBalance("mystery", [entry])).toThrow(InvalidAccountError);
  });
});

describe("planStoreCreditSpend", () => {
  const d = (iso: string): Date => new Date(iso);
  const bal = (sub: StoreCreditSub, n: bigint, expiresAt: Date | null): SubBalanceState => ({
    sub,
    balance: m(n),
    expiresAt,
  });
  const keys = (plan: ReturnType<typeof planStoreCreditSpend>): [string, bigint][] =>
    plan.map((p) => [subBalanceKey(p.sub), p.amount.amount]);

  it("rejects non-positive amounts with the documented message", () => {
    for (const n of [0n, -1n]) {
      expect(() => planStoreCreditSpend([], m(n))).toThrow(InvalidChartInputError);
      expect(() => planStoreCreditSpend([], m(n))).toThrow("spend amount must be positive");
    }
  });

  it("spends soonest-expiring first, then non-expiring, then refund credit", () => {
    const balances = [
      bal({ kind: "refund_credit" }, 100n, null),
      bal({ kind: "goodwill" }, 100n, null),
      bal({ kind: "cashback_coins" }, 100n, d("2027-01-01T00:00:00Z")),
      bal({ kind: "referral_credit" }, 100n, d("2026-12-01T00:00:00Z")),
    ];
    expect(keys(planStoreCreditSpend(balances, m(400n)))).toEqual([
      ["referral_credit", 100n],
      ["cashback_coins", 100n],
      ["goodwill", 100n],
      ["refund_credit", 100n],
    ]);
    // same result for any input order
    expect(keys(planStoreCreditSpend([...balances].reverse(), m(400n)))).toEqual([
      ["referral_credit", 100n],
      ["cashback_coins", 100n],
      ["goodwill", 100n],
      ["refund_credit", 100n],
    ]);
  });

  it("orders by expiry ascending regardless of key, and by key on equal expiry", () => {
    const early = d("2026-11-01T00:00:00Z");
    const late = d("2026-12-01T00:00:00Z");
    expect(
      keys(
        planStoreCreditSpend(
          [bal({ kind: "cashback_coins" }, 5n, late), bal({ kind: "goodwill" }, 5n, early)],
          m(10n),
        ),
      ),
    ).toEqual([
      ["goodwill", 5n],
      ["cashback_coins", 5n],
    ]);
    expect(
      keys(
        planStoreCreditSpend(
          [bal({ kind: "goodwill" }, 5n, early), bal({ kind: "cashback_coins" }, 5n, early)],
          m(10n),
        ),
      ),
    ).toEqual([
      ["cashback_coins", 5n],
      ["goodwill", 5n],
    ]);
    expect(
      keys(
        planStoreCreditSpend(
          [bal({ kind: "goodwill" }, 5n, null), bal({ kind: "cashback_coins" }, 5n, null)],
          m(10n),
        ),
      ),
    ).toEqual([
      ["cashback_coins", 5n],
      ["goodwill", 5n],
    ]);
    expect(
      keys(
        planStoreCreditSpend(
          [
            bal({ kind: "gift_card", cardId: "b" }, 5n, null),
            bal({ kind: "gift_card", cardId: "a" }, 5n, null),
          ],
          m(10n),
        ),
      ),
    ).toEqual([
      ["gift_card:a", 5n],
      ["gift_card:b", 5n],
    ]);
  });

  it("takes only what is needed, from the first balances, and stops", () => {
    const plan = planStoreCreditSpend(
      [
        bal({ kind: "goodwill" }, 70n, d("2026-11-01T00:00:00Z")),
        bal({ kind: "cashback_coins" }, 70n, d("2026-12-01T00:00:00Z")),
        bal({ kind: "refund_credit" }, 70n, null),
      ],
      m(100n),
    );
    expect(keys(plan)).toEqual([
      ["goodwill", 70n],
      ["cashback_coins", 30n],
    ]);
    expect(keys(planStoreCreditSpend([bal({ kind: "goodwill" }, 100n, null)], m(100n)))).toEqual([["goodwill", 100n]]);
    expect(
      keys(
        planStoreCreditSpend(
          [bal({ kind: "goodwill" }, 100n, d("2026-11-01T00:00:00Z")), bal({ kind: "refund_credit" }, 5n, null)],
          m(100n),
        ),
      ),
    ).toEqual([["goodwill", 100n]]);
    expect(keys(planStoreCreditSpend([bal({ kind: "goodwill" }, 100n, null)], m(1n)))).toEqual([["goodwill", 1n]]);
  });

  it("ranks dated before non-expiring before refund credit, using pairs whose key order is the opposite", () => {
    // key order would put goodwill before referral_credit, but dated expiry must win
    expect(
      keys(
        planStoreCreditSpend(
          [bal({ kind: "goodwill" }, 5n, null), bal({ kind: "referral_credit" }, 5n, d("2099-01-01T00:00:00Z"))],
          m(10n),
        ),
      ),
    ).toEqual([
      ["referral_credit", 5n],
      ["goodwill", 5n],
    ]);
    // refund_credit with an expiry date still goes last
    expect(
      keys(
        planStoreCreditSpend(
          [bal({ kind: "refund_credit" }, 5n, d("2020-01-01T00:00:00Z")), bal({ kind: "goodwill" }, 5n, d("2099-01-01T00:00:00Z"))],
          m(10n),
        ),
      ),
    ).toEqual([
      ["goodwill", 5n],
      ["refund_credit", 5n],
    ]);
    // refund_credit with no expiry goes after non-expiring credit whose key sorts later
    expect(
      keys(
        planStoreCreditSpend(
          [bal({ kind: "refund_credit" }, 5n, null), bal({ kind: "gift_card", cardId: "z" }, 5n, null)],
          m(10n),
        ),
      ),
    ).toEqual([
      ["gift_card:z", 5n],
      ["refund_credit", 5n],
    ]);
  });

  it("is stable for equal keys and tolerates mixed dated and undated refund credit", () => {
    const first = bal({ kind: "refund_credit" }, 10n, null);
    const second = bal({ kind: "refund_credit" }, 20n, null);
    expect(keys(planStoreCreditSpend([first, second], m(15n)))).toEqual([
      ["refund_credit", 10n],
      ["refund_credit", 5n],
    ]);
    const dated = bal({ kind: "refund_credit" }, 10n, d("2026-11-01T00:00:00Z"));
    const undated = bal({ kind: "refund_credit" }, 20n, null);
    expect(keys(planStoreCreditSpend([dated, undated], m(15n)))).toEqual([
      ["refund_credit", 10n],
      ["refund_credit", 5n],
    ]);
    expect(keys(planStoreCreditSpend([undated, dated], m(15n)))).toEqual([["refund_credit", 15n]]);
  });

  it("produces the same order for every permutation of the input", () => {
    const early = d("2026-11-01T00:00:00Z");
    const late = d("2026-12-01T00:00:00Z");
    const items: SubBalanceState[] = [
      bal({ kind: "referral_credit" }, 1n, early),
      bal({ kind: "goodwill" }, 1n, late),
      bal({ kind: "cashback_coins" }, 1n, null),
      bal({ kind: "gift_card", cardId: "a" }, 1n, null),
      bal({ kind: "gift_card", cardId: "b" }, 1n, null),
      bal({ kind: "refund_credit" }, 1n, null),
    ];
    const expected = [
      "referral_credit",
      "goodwill",
      "cashback_coins",
      "gift_card:a",
      "gift_card:b",
      "refund_credit",
    ];
    const permute = (arr: SubBalanceState[]): SubBalanceState[][] =>
      arr.length <= 1
        ? [arr]
        : arr.flatMap((x, i) => permute([...arr.slice(0, i), ...arr.slice(i + 1)]).map((r) => [x, ...r]));
    for (const perm of permute(items)) {
      expect(planStoreCreditSpend(perm, m(6n)).map((p) => subBalanceKey(p.sub))).toEqual(expected);
    }
  });

  it("ignores empty and negative sub-balances", () => {
    const plan = planStoreCreditSpend(
      [bal({ kind: "goodwill" }, 0n, d("2026-11-01T00:00:00Z")), bal({ kind: "cashback_coins" }, -5n, null), bal({ kind: "referral_credit" }, 1n, null)],
      m(1n),
    );
    expect(keys(plan)).toEqual([["referral_credit", 1n]]);
  });

  it("reports the shortfall and does not mutate its input", () => {
    const balances = [bal({ kind: "cashback_coins" }, 30n, null), bal({ kind: "goodwill" }, 20n, null)];
    const copy = [...balances];
    expect(() => planStoreCreditSpend(balances, m(60n))).toThrow(InsufficientCreditError);
    expect(() => planStoreCreditSpend(balances, m(60n))).toThrow("short by 10 piastres of store credit");
    expect(() => planStoreCreditSpend([], m(7n))).toThrow("short by 7 piastres of store credit");
    expect(balances).toEqual(copy);
    expect(balances[0]?.sub.kind).toBe("cashback_coins");
  });

  it("keeps the currency and the spent total equal to the request", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 1_000n }), { minLength: 1, maxLength: 6 }),
        fc.bigInt({ min: 1n, max: 3_000n }),
        (amounts, want) => {
          const kinds = ["cashback_coins", "referral_credit", "goodwill", "refund_credit"] as const;
          const balances = amounts.map((a, i) =>
            i < kinds.length
              ? bal({ kind: kinds[i] ?? "goodwill" } as StoreCreditSub, a, null)
              : bal({ kind: "gift_card", cardId: `c${i}` }, a, null),
          );
          const total = amounts.reduce((s, a) => s + a, 0n);
          if (want > total) {
            expect(() => planStoreCreditSpend(balances, m(want))).toThrow(InsufficientCreditError);
          } else {
            const plan = planStoreCreditSpend(balances, m(want));
            expect(plan.reduce((s, p) => s + p.amount.amount, 0n)).toBe(want);
            expect(plan.every((p) => p.amount.currency === "EGP" && p.amount.amount > 0n)).toBe(true);
          }
        },
      ),
    );
  });
});

describe("rates and helpers", () => {
  it("vatIncluded extracts VAT from a gross amount with one half-even rounding", () => {
    expect(vatIncluded(m(11_400n), 1_400n).amount).toBe(1_400n);
    expect(vatIncluded(m(114n), 1_400n).amount).toBe(14n);
    expect(vatIncluded(m(100n), 0n).amount).toBe(0n);
    expect(vatIncluded(m(1n), 1_400n).amount).toBe(0n);
    expect(vatIncluded(m(10_000n), 100_000n).amount).toBe(9_091n);
  });

  it("validates vat bps between 0 and 100_000 inclusive", () => {
    expect(() => vatIncluded(m(1n), -1n)).toThrow(InvalidChartInputError);
    expect(() => vatIncluded(m(1n), -1n)).toThrow("vatBps must be between 0 and 100000 bps");
    expect(() => vatIncluded(m(1n), 100_001n)).toThrow("vatBps must be between 0 and 100000 bps");
    expect(() => vatIncluded(m(1n), 100_000n)).not.toThrow();
    expect(() => commissionVatOf(m(1n), 100_001n)).toThrow("vatBps must be between 0 and 100000 bps");
    expect(() => commissionVatOf(m(1n), -1n)).toThrow(InvalidChartInputError);
    expect(commissionVatOf(m(10_000n), 1_400n).amount).toBe(1_400n);
    expect(commissionVatOf(m(5n), 5_000n).amount).toBe(2n);
  });

  it("commissionOf validates 0..10_000 bps inclusive and rounds half-even", () => {
    expect(commissionOf(m(100_000n), 1_000n).amount).toBe(10_000n);
    expect(commissionOf(m(100_000n), 0n).amount).toBe(0n);
    expect(commissionOf(m(100_000n), 10_000n).amount).toBe(100_000n);
    expect(commissionOf(m(25n), 1_000n).amount).toBe(2n);
    expect(commissionOf(m(35n), 1_000n).amount).toBe(4n);
    expect(() => commissionOf(m(1n), -1n)).toThrow("commissionBps must be between 0 and 10000 bps");
    expect(() => commissionOf(m(1n), 10_001n)).toThrow("commissionBps must be between 0 and 10000 bps");
    expect(() => commissionOf(m(1n), 10_001n)).toThrow(InvalidChartInputError);
  });

  it("allocateVoucher splits by merchandise with largest remainder", () => {
    expect(allocateVoucher(m(100n), [m(1n), m(1n), m(1n)]).map((x) => x.amount)).toEqual([34n, 33n, 33n]);
    expect(allocateVoucher(m(10n), [m(100n), m(300n)]).map((x) => x.amount)).toEqual([3n, 7n]);
  });
});

describe("tenderAccount", () => {
  it("maps each tender kind to its account", () => {
    expect(tenderAccount({ kind: "psp", psp: "kashier", amount: m(1n) })).toBe("psp_clearing:kashier");
    expect(tenderAccount({ kind: "cod", courier: "bosta", amount: m(1n) })).toBe("cod_clearing:bosta");
    expect(tenderAccount({ kind: "bnpl", provider: "valu", amount: m(1n) })).toBe("bnpl_clearing:valu");
    expect(tenderAccount({ kind: "store_credit", userId: "u1", sub: { kind: "goodwill" }, amount: m(1n) })).toBe(
      "store_credit:u1:goodwill",
    );
  });
});

describe("orderRecognised", () => {
  const psp = (n: bigint): Tender => ({ kind: "psp", psp: "kashier", amount: m(n) });
  const base = {
    sellerOrders: [{ storeId: "A", merchandise: m(100_000n), commissionBps: 1_000n }],
    shippingGross: m(5_700n),
    vatBps: 1_400n,
    tenders: [psp(105_700n)],
  };

  it("posts exact seller, commission, VAT, shipping and tender lines", () => {
    const e = orderRecognised(base, META);
    expect(e.kind).toBe("order_recognised");
    expect(e.id).toBe("e-1");
    expect(e.idempotencyKey).toBe("key-1");
    expect(e.occurredAt).toBe(at);
    expect(e.ref).toEqual({ type: "order_group", id: "og-1" });
    expect(view(e)).toEqual([
      ["seller_payable:A", -88_600n],
      ["platform_commission", -10_000n],
      ["platform_vat_output", -1_400n],
      ["shipping_revenue", -5_000n],
      ["platform_vat_output", -700n],
      ["psp_clearing:kashier", 105_700n],
    ]);
  });

  it("books platform- and seller-funded discounts without changing seller credit", () => {
    const e = orderRecognised(
      {
        ...base,
        sellerOrders: [
          { storeId: "A", merchandise: m(100_000n), commissionBps: 1_000n, platformFundedDiscount: m(2_000n), sellerFundedDiscount: m(3_000n) },
        ],
        tenders: [psp(100_700n)],
      },
      META,
    );
    expect(view(e)).toEqual([
      ["seller_payable:A", -88_600n],
      ["platform_commission", -10_000n],
      ["platform_vat_output", -1_400n],
      ["promo_expense_platform", 2_000n],
      ["promo_receivable_seller:A", 3_000n],
      ["shipping_revenue", -5_000n],
      ["platform_vat_output", -700n],
      ["psp_clearing:kashier", 100_700n],
    ]);
  });

  it("handles several seller orders and split tenders of every kind", () => {
    const e = orderRecognised(
      {
        sellerOrders: [
          { storeId: "A", merchandise: m(10_000n), commissionBps: 1_000n },
          { storeId: "B", merchandise: m(20_000n), commissionBps: 500n },
        ],
        shippingGross: m(0n),
        vatBps: 1_400n,
        tenders: [
          { kind: "cod", courier: "bosta", amount: m(10_000n) },
          { kind: "bnpl", provider: "valu", amount: m(5_000n) },
          { kind: "store_credit", userId: "u1", sub: { kind: "goodwill" }, amount: m(15_000n) },
        ],
      },
      META,
    );
    expect(view(e)).toEqual([
      ["seller_payable:A", -8_860n],
      ["platform_commission", -1_000n],
      ["platform_vat_output", -140n],
      ["seller_payable:B", -18_860n],
      ["platform_commission", -1_000n],
      ["platform_vat_output", -140n],
      ["cod_clearing:bosta", 10_000n],
      ["bnpl_clearing:valu", 5_000n],
      ["store_credit:u1:goodwill", 15_000n],
    ]);
  });

  it("rejects invalid input with the documented messages", () => {
    const err = (input: unknown, msg: string, type: new (...a: never[]) => Error = InvalidChartInputError): void => {
      expect(() => orderRecognised(input as typeof base, META)).toThrow(type);
      expect(() => orderRecognised(input as typeof base, META)).toThrow(msg);
    };
    err({ ...base, sellerOrders: [] }, "an order needs a seller order");
    err({ ...base, shippingGross: m(-1n) }, "shippingGross must not be negative");
    err({ ...base, sellerOrders: [{ storeId: "A", merchandise: m(0n), commissionBps: 0n }] }, "merchandise must be positive");
    err(
      { ...base, sellerOrders: [{ storeId: "A", merchandise: m(100n), commissionBps: 0n, platformFundedDiscount: m(-1n) }] },
      "platformFundedDiscount must not be negative",
    );
    err(
      { ...base, sellerOrders: [{ storeId: "A", merchandise: m(100n), commissionBps: 0n, sellerFundedDiscount: m(-1n) }] },
      "sellerFundedDiscount must not be negative",
    );
    err(
      { ...base, sellerOrders: [{ storeId: "A", merchandise: m(100n), commissionBps: 0n, platformFundedDiscount: m(60n), sellerFundedDiscount: m(41n) }] },
      "discounts exceed merchandise value",
    );
    err(
      { ...base, sellerOrders: [{ storeId: "A", merchandise: m(100n), commissionBps: 10_000n }], vatBps: 1_400n },
      "commission and VAT exceed the merchandise value",
    );
    err({ ...base, tenders: [psp(0n)] }, "tender amount must be positive");
    err({ ...base, tenders: [psp(105_699n)] }, "tenders 105699 differ from payable 105700", TenderMismatchError);
    err({ ...base, tenders: [psp(105_701n)] }, "tenders 105701 differ from payable 105700", TenderMismatchError);
    err({ ...base, vatBps: 100_001n }, "vatBps must be between 0 and 100000 bps");
    err({ ...base, sellerOrders: [{ storeId: "A", merchandise: m(100n), commissionBps: 10_001n }] }, "commissionBps must be between");
  });

  it("accepts discounts that equal the merchandise exactly (no off-by-one)", () => {
    const e = orderRecognised(
      {
        sellerOrders: [
          { storeId: "A", merchandise: m(1_000n), commissionBps: 0n, platformFundedDiscount: m(400n), sellerFundedDiscount: m(600n) },
        ],
        shippingGross: m(500n),
        vatBps: 0n,
        tenders: [psp(500n)],
      },
      META,
    );
    expect(view(e).at(-1)).toEqual(["psp_clearing:kashier", 500n]);
  });

  it("accepts commission + VAT exactly equal to the merchandise (seller net zero is skipped)", () => {
    const e = orderRecognised(
      {
        sellerOrders: [{ storeId: "A", merchandise: m(1_000n), commissionBps: 10_000n }],
        shippingGross: m(0n),
        vatBps: 0n,
        tenders: [psp(1_000n)],
      },
      META,
    );
    expect(view(e)).toEqual([
      ["platform_commission", -1_000n],
      ["psp_clearing:kashier", 1_000n],
    ]);
  });
});

describe("refundIssued", () => {
  const psp = (n: bigint): Tender => ({ kind: "psp", psp: "kashier", amount: m(n) });
  const base = {
    storeId: "A",
    commissionBps: 1_000n,
    vatBps: 1_400n,
    goodsRefunded: m(50_000n),
    goodsRefundedBefore: m(0n),
    destinations: [psp(50_000n)],
  };

  it("mirrors the order components for the refunded portion", () => {
    const e = refundIssued(base, META);
    expect(e.kind).toBe("refund_issued");
    expect(e.idempotencyKey).toBe("key-1");
    expect(view(e)).toEqual([
      ["seller_payable:A", 44_300n],
      ["platform_commission", 5_000n],
      ["platform_vat_output", 700n],
      ["psp_clearing:kashier", -50_000n],
    ]);
  });

  it("includes returned shipping and discount shares", () => {
    const e = refundIssued(
      {
        ...base,
        platformFundedDiscount: m(1_000n),
        sellerFundedDiscount: m(500n),
        shippingGross: m(5_700n),
        destinations: [psp(54_200n)],
      },
      META,
    );
    expect(view(e)).toEqual([
      ["seller_payable:A", 44_300n],
      ["platform_commission", 5_000n],
      ["platform_vat_output", 700n],
      ["promo_expense_platform", -1_000n],
      ["promo_receivable_seller:A", -500n],
      ["shipping_revenue", 5_000n],
      ["platform_vat_output", 700n],
      ["psp_clearing:kashier", -54_200n],
    ]);
  });

  it("differences cumulative commission so partial refunds add up exactly", () => {
    // 3 goods of 335 at 10%: cumulative commission 33.5 -> 34 (half-even 33.5 -> 34) etc.
    const parts = [335n, 335n, 330n];
    let before = 0n;
    let commission = 0n;
    for (const part of parts) {
      const e = refundIssued(
        { ...base, goodsRefunded: m(part), goodsRefundedBefore: m(before), destinations: [psp(part)] },
        META,
      );
      commission += e.postings.find((p) => p.account === "platform_commission")?.amount.amount ?? 0n;
      before += part;
    }
    expect(commission).toBe(commissionOf(m(1_000n), 1_000n).amount);
  });

  const NUM_RUNS = Number(process.env["FC_RUNS"] ?? 2_000);
  const SEED = process.env["FC_SEED"] === undefined ? undefined : Number(process.env["FC_SEED"]);
  const four = (es: JournalEntry[]): bigint[] =>
    ["seller_payable:A", "platform_commission", "platform_vat_output", "psp_clearing:kashier"].map(
      (a) => derivedBalance(a, es).amount,
    );
  const orderFor = (goods: bigint, bps: bigint, vatBps: bigint): JournalEntry | undefined => {
    try {
      return orderRecognised(
        {
          sellerOrders: [{ storeId: "A", merchandise: m(goods), commissionBps: bps }],
          shippingGross: m(0n),
          vatBps,
          tenders: [psp(goods)],
        },
        META,
      );
    } catch (e) {
      if (e instanceof InvalidChartInputError) return undefined;
      throw e;
    }
  };
  const refundSlices = (parts: bigint[], bps: bigint, vatBps: bigint): JournalEntry[] => {
    let before = 0n;
    return parts.map((g) => {
      const e = refundIssued(
        { ...base, commissionBps: bps, vatBps, goodsRefunded: m(g), goodsRefundedBefore: m(before), destinations: [psp(g)] },
        META,
      );
      before += g;
      return e;
    });
  };

  it("holds for arbitrary splits", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 90_000n }), { minLength: 1, maxLength: 6 }),
        fc.bigInt({ min: 0n, max: 10_000n }),
        fc.constantFrom(0n, 1_400n, 10_000n, 100_000n),
        (parts, bps, vatBps) => {
          const total = parts.reduce((x, y) => x + y, 0n);
          const order = orderFor(total, bps, vatBps);
          fc.pre(order !== undefined);
          const slices = refundSlices(parts, bps, vatBps);
          for (const e of slices) {
            for (const a of ["platform_commission", "platform_vat_output"]) {
              expect(e.postings.filter((p) => p.account === a).every((p) => p.amount.amount >= 0n)).toBe(true);
            }
          }
          expect(four([order as JournalEntry, ...slices])).toEqual([0n, 0n, 0n, 0n]);
          const whole = refundSlices([total], bps, vatBps);
          expect(four(slices)).toEqual(four(whole));
        },
      ),
      { numRuns: NUM_RUNS, ...(SEED === undefined ? {} : { seed: SEED }) },
    );
  }, 600_000);

  it("refunds the reviewer counterexample (500 bps commission, 100000 bps VAT, 11 goods, slices [10, 1])", () => {
    const order = orderFor(11n, 500n, 100_000n);
    expect(order).toBeDefined();
    const slices = refundSlices([10n, 1n], 500n, 100_000n);
    const last = slices[1] as JournalEntry;
    expect(last.postings.find((p) => p.account === "seller_payable:A")?.amount.amount).toBe(-10n);
    expect(four([order as JournalEntry, ...slices])).toEqual([0n, 0n, 0n, 0n]);
  });

  it("is pure: the same input twice gives equal entries", () => {
    const input = { ...base, commissionBps: 2_976n, goodsRefunded: m(1n), goodsRefundedBefore: m(103_240n), destinations: [psp(1n)] };
    expect(refundIssued(input, META)).toEqual(refundIssued(input, META));
  });

  it("refunds a final 1-piastre slice whose rounded commission and VAT exceed it (seed 1 counterexample)", () => {
    // Found by fast-check seed 1, path 4272:41:23:21:19: goods [89998, 13242, 1] at 2976 bps commission.
    // The cumulative half-even difference gives the last piastre 1 commission + 1 VAT, so the slice's
    // seller net is -1. Rejecting it would make the order impossible to refund in full; the sum telescopes.
    const bps = 2_976n;
    let before = 0n;
    let commission = 0n;
    let vat = 0n;
    let payable = 0n;
    for (const g of [89_998n, 13_242n, 1n]) {
      const e = refundIssued(
        { ...base, commissionBps: bps, goodsRefunded: m(g), goodsRefundedBefore: m(before), destinations: [psp(g)] },
        META,
      );
      const amt = (a: string): bigint => e.postings.filter((p) => p.account === a).reduce((x, p) => x + p.amount.amount, 0n);
      commission += amt("platform_commission");
      vat += amt("platform_vat_output");
      payable += amt("seller_payable:A");
      before += g;
    }
    const total = commissionOf(m(before), bps);
    expect(commission).toBe(total.amount);
    expect(vat).toBe(commissionVatOf(total, 1_400n).amount);
    expect(payable).toBe(before - total.amount - commissionVatOf(total, 1_400n).amount);
  });

  it("rejects invalid input with the documented messages", () => {
    const err = (patch: object, msg: string, type: new (...a: never[]) => Error = InvalidChartInputError): void => {
      expect(() => refundIssued({ ...base, ...patch }, META)).toThrow(type);
      expect(() => refundIssued({ ...base, ...patch }, META)).toThrow(msg);
    };
    err({ goodsRefunded: m(0n) }, "goodsRefunded must be positive");
    err({ goodsRefundedBefore: m(-1n) }, "goodsRefundedBefore must not be negative");
    err({ platformFundedDiscount: m(-1n) }, "platformFundedDiscount must not be negative");
    err({ sellerFundedDiscount: m(-1n) }, "sellerFundedDiscount must not be negative");
    err({ shippingGross: m(-1n) }, "shippingGross must not be negative");
    err(
      { platformFundedDiscount: m(30_000n), sellerFundedDiscount: m(20_001n) },
      "discounts exceed refunded merchandise value",
    );
    err({ destinations: [psp(0n)] }, "destination amount must be positive");
    err({ destinations: [psp(49_999n)] }, "destinations 49999 differ from refund 50000", TenderMismatchError);
    err({ destinations: [psp(50_001n)] }, "destinations 50001 differ from refund 50000", TenderMismatchError);
    err({ commissionBps: 10_001n }, "commissionBps must be between 0 and 10000 bps");
    err({ vatBps: 100_001n }, "vatBps must be between 0 and 100000 bps");
  });

  it("accepts discounts equal to the refunded goods", () => {
    const e = refundIssued(
      { ...base, platformFundedDiscount: m(30_000n), sellerFundedDiscount: m(20_000n), destinations: [] },
      META,
    );
    expect(e.postings).toBeDefined();
  });

  it("refunds to several destinations", () => {
    const e = refundIssued(
      {
        ...base,
        destinations: [
          { kind: "store_credit", userId: "u1", sub: { kind: "refund_credit" }, amount: m(20_000n) },
          { kind: "bnpl", provider: "valu", amount: m(30_000n) },
        ],
      },
      META,
    );
    expect(view(e).slice(-2)).toEqual([
      ["store_credit:u1:refund_credit", -20_000n],
      ["bnpl_clearing:valu", -30_000n],
    ]);
  });
});

describe("clearingSettled", () => {
  it("settles a PSP with a provider fee", () => {
    const e = clearingSettled(
      { party: { kind: "psp", psp: "kashier" }, gross: m(10_000n), fee: m(250n), bankAccount: "cib" },
      META,
    );
    expect(e.kind).toBe("clearing_settled");
    expect(view(e)).toEqual([
      ["bank_settlement:cib", 9_750n],
      ["provider_fee_expense", 250n],
      ["psp_clearing:kashier", -10_000n],
    ]);
  });

  it("uses the courier fee account for COD and the provider fee account for BNPL", () => {
    expect(
      view(clearingSettled({ party: { kind: "cod", courier: "bosta" }, gross: m(1_000n), fee: m(50n), bankAccount: "b" }, META)),
    ).toEqual([
      ["bank_settlement:b", 950n],
      ["courier_fee_expense", 50n],
      ["cod_clearing:bosta", -1_000n],
    ]);
    expect(
      view(clearingSettled({ party: { kind: "bnpl", provider: "valu" }, gross: m(1_000n), fee: m(50n), bankAccount: "b" }, META)),
    ).toEqual([
      ["bank_settlement:b", 950n],
      ["provider_fee_expense", 50n],
      ["bnpl_clearing:valu", -1_000n],
    ]);
  });

  it("skips a zero fee", () => {
    expect(
      view(clearingSettled({ party: { kind: "psp", psp: "p" }, gross: m(100n), fee: m(0n), bankAccount: "b" }, META)),
    ).toEqual([
      ["bank_settlement:b", 100n],
      ["psp_clearing:p", -100n],
    ]);
  });

  it("validates gross and fee with exact boundaries", () => {
    const input = (gross: bigint, fee: bigint) => ({
      party: { kind: "psp", psp: "p" } as const,
      gross: m(gross),
      fee: m(fee),
      bankAccount: "b",
    });
    expect(() => clearingSettled(input(0n, 0n), META)).toThrow("gross must be positive");
    expect(() => clearingSettled(input(-1n, 0n), META)).toThrow("gross must be positive");
    expect(() => clearingSettled(input(10n, -1n), META)).toThrow("fee must not be negative");
    expect(() => clearingSettled(input(10n, 10n), META)).toThrow("fee must be less than gross");
    expect(() => clearingSettled(input(10n, 11n), META)).toThrow(InvalidChartInputError);
    expect(() => clearingSettled(input(10n, 9n), META)).not.toThrow();
    expect(() => clearingSettled(input(1n, 0n), META)).not.toThrow();
  });
});

describe("payouts and netting", () => {
  it("sellerPayout debits the payable and credits the bank", () => {
    const e = sellerPayout({ storeId: "A", amount: m(7_000n), bankAccount: "cib" }, META);
    expect(e.kind).toBe("seller_payout");
    expect(view(e)).toEqual([
      ["seller_payable:A", 7_000n],
      ["bank_settlement:cib", -7_000n],
    ]);
    expect(() => sellerPayout({ storeId: "A", amount: m(0n), bankAccount: "cib" }, META)).toThrow(
      "amount must be positive",
    );
    expect(() => sellerPayout({ storeId: "A", amount: m(1n), bankAccount: "cib" }, META)).not.toThrow();
  });

  it("sellerPromoNetted moves the receivable against the payable", () => {
    const e = sellerPromoNetted({ storeId: "A", amount: m(300n) }, META);
    expect(e.kind).toBe("seller_promo_netted");
    expect(view(e)).toEqual([
      ["seller_payable:A", 300n],
      ["promo_receivable_seller:A", -300n],
    ]);
    expect(() => sellerPromoNetted({ storeId: "A", amount: m(0n) }, META)).toThrow("amount must be positive");
  });
});

describe("gift cards", () => {
  it("giftCardSold debits the tender and credits the liability", () => {
    const e = giftCardSold({ tender: { kind: "psp", psp: "kashier", amount: m(50_000n) } }, META);
    expect(e.kind).toBe("gift_card_sold");
    expect(view(e)).toEqual([
      ["psp_clearing:kashier", 50_000n],
      ["gift_card_liability", -50_000n],
    ]);
    expect(
      view(giftCardSold({ tender: { kind: "bnpl", provider: "valu", amount: m(100n) } }, META))[0],
    ).toEqual(["bnpl_clearing:valu", 100n]);
  });

  it("rejects store credit and COD tenders and non-positive amounts", () => {
    expect(() =>
      giftCardSold({ tender: { kind: "store_credit", userId: "u", sub: { kind: "goodwill" }, amount: m(1n) } }, META),
    ).toThrow("a gift card cannot be bought with store credit");
    expect(() => giftCardSold({ tender: { kind: "cod", courier: "b", amount: m(1n) } }, META)).toThrow(
      "a gift card cannot be bought cash on delivery",
    );
    expect(() => giftCardSold({ tender: { kind: "psp", psp: "p", amount: m(0n) } }, META)).toThrow(
      "amount must be positive",
    );
  });

  it("giftCardRedeemed moves liability into the gift_card sub-balance", () => {
    const e = giftCardRedeemed({ userId: "u1", cardId: "c1", amount: m(2_000n) }, META);
    expect(e.kind).toBe("gift_card_redeemed");
    expect(view(e)).toEqual([
      ["gift_card_liability", 2_000n],
      ["store_credit:u1:gift_card:c1", -2_000n],
    ]);
    expect(() => giftCardRedeemed({ userId: "u1", cardId: "c1", amount: m(0n) }, META)).toThrow(
      "amount must be positive",
    );
  });
});

describe("store credit grants and expiry", () => {
  it("storeCreditGranted expenses the platform and credits the sub-balance", () => {
    const e = storeCreditGranted({ userId: "u1", sub: { kind: "referral_credit" }, amount: m(10_000n) }, META);
    expect(e.kind).toBe("store_credit_granted");
    expect(view(e)).toEqual([
      ["promo_expense_platform", 10_000n],
      ["store_credit:u1:referral_credit", -10_000n],
    ]);
    expect(() => storeCreditGranted({ userId: "u1", sub: { kind: "goodwill" }, amount: m(0n) }, META)).toThrow(
      "amount must be positive",
    );
  });

  it("storeCreditExpired reverses the expense", () => {
    const e = storeCreditExpired({ userId: "u1", sub: { kind: "cashback_coins" }, amount: m(300n) }, META);
    expect(e.kind).toBe("store_credit_expired");
    expect(view(e)).toEqual([
      ["store_credit:u1:cashback_coins", 300n],
      ["promo_expense_platform", -300n],
    ]);
    expect(() => storeCreditExpired({ userId: "u1", sub: { kind: "goodwill" }, amount: m(0n) }, META)).toThrow(
      "amount must be positive",
    );
  });
});

describe("Plus", () => {
  it("plusCharged defers net revenue and books VAT", () => {
    const e = plusCharged({ tender: { kind: "psp", psp: "kashier", amount: m(20_000n) }, vatBps: 1_400n }, META);
    expect(e.kind).toBe("plus_charged");
    expect(view(e)).toEqual([
      ["psp_clearing:kashier", 20_000n],
      ["deferred_plus_revenue", -17_544n],
      ["platform_vat_output", -2_456n],
    ]);
  });

  it("rejects store credit and COD, non-positive amounts and bad VAT", () => {
    expect(() =>
      plusCharged({ tender: { kind: "store_credit", userId: "u", sub: { kind: "goodwill" }, amount: m(1n) }, vatBps: 0n }, META),
    ).toThrow("Plus cannot be bought with store credit");
    expect(() => plusCharged({ tender: { kind: "cod", courier: "b", amount: m(1n) }, vatBps: 0n }, META)).toThrow(
      "Plus cannot be bought cash on delivery",
    );
    expect(() => plusCharged({ tender: { kind: "psp", psp: "p", amount: m(0n) }, vatBps: 0n }, META)).toThrow(
      "amount must be positive",
    );
    expect(() => plusCharged({ tender: { kind: "psp", psp: "p", amount: m(1n) }, vatBps: 100_001n }, META)).toThrow(
      "vatBps must be between",
    );
  });

  it("plusRevenueRecognised moves deferred into recognised revenue", () => {
    const e = plusRevenueRecognised({ amount: m(1_462n) }, META);
    expect(e.kind).toBe("plus_revenue_recognised");
    expect(view(e)).toEqual([
      ["deferred_plus_revenue", 1_462n],
      ["plus_revenue", -1_462n],
    ]);
    expect(() => plusRevenueRecognised({ amount: m(0n) }, META)).toThrow("amount must be positive");
  });

  it("planPlusRecognition splits exactly and validates the period count", () => {
    expect(planPlusRecognition(m(17_544n), 12).map((x) => x.amount)).toEqual([
      1_462n, 1_462n, 1_462n, 1_462n, 1_462n, 1_462n, 1_462n, 1_462n, 1_462n, 1_462n, 1_462n, 1_462n,
    ]);
    expect(planPlusRecognition(m(10n), 3).map((x) => x.amount)).toEqual([4n, 3n, 3n]);
    expect(planPlusRecognition(m(10n), 1).map((x) => x.amount)).toEqual([10n]);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => planPlusRecognition(m(10n), bad)).toThrow(InvalidChartInputError);
      expect(() => planPlusRecognition(m(10n), bad)).toThrow("periods must be a positive integer");
    }
  });
});
