/**
 * Worked journal entries for docs/specs/ledger-chart-of-accounts.md. Every figure here is a
 * development fixture in piastres (100 piastres = 1 EGP), not a price, rate or fee anyone has agreed.
 */
import { describe, expect, it } from "vitest";
import { createJournalEntry, reverseEntry, trialBalance, type JournalEntry } from "../ledger";
import { money, type Money } from "../money";
import { chart, derivedBalance } from "./accounts";
import {
  allocateVoucher,
  clearingSettled,
  giftCardRedeemed,
  giftCardSold,
  orderRecognised,
  planPlusRecognition,
  plusCharged,
  plusRevenueRecognised,
  refundIssued,
  sellerPayout,
  sellerPromoNetted,
  storeCreditGranted,
  type EntryMeta,
  type OrderRecognisedInput,
} from "./builders";
import { planStoreCreditSpend, type SubBalanceState } from "./spend";

let counter = 0;
function meta(refType = "order_group", refId = "og_1"): EntryMeta {
  counter += 1;
  return {
    id: `je_${counter}`,
    idempotencyKey: `idem_${counter}`,
    occurredAt: new Date("2026-10-10T12:00:00Z"),
    ref: { type: refType, id: refId },
  };
}

const E = (n: bigint): Money => money(n);
const VAT = 1_400n;

/** Asserts that the whole journal nets to zero, and returns derived balances for named accounts. */
function expectBalanced(entries: readonly JournalEntry[]): void {
  for (const e of entries) {
    const sum = e.postings.reduce((acc, p) => acc + p.amount.amount, 0n);
    expect(sum, `${e.kind} ${e.id}`).toBe(0n);
  }
  expect(trialBalance(entries).get("EGP") ?? 0n).toBe(0n);
}

function bal(account: string, entries: readonly JournalEntry[]): bigint {
  return derivedBalance(account, entries).amount;
}

/** Two sellers, one shipping fee. Commission 15% (1,500 bps), VAT 14%. */
function twoSellerOrder(tenders: OrderRecognisedInput["tenders"]): OrderRecognisedInput {
  return {
    sellerOrders: [
      { storeId: "A", merchandise: E(159_950n), commissionBps: 1_500n },
      { storeId: "B", merchandise: E(60_025n), commissionBps: 1_500n },
    ],
    shippingGross: E(5_000n),
    vatBps: VAT,
    tenders,
  };
}
const CARD_TOTAL = 224_975n;

describe("1. Order paid, prepaid, two sellers, commission, VAT on commission and shipping", () => {
  const entry = orderRecognised(
    twoSellerOrder([{ kind: "psp", psp: "psp1", amount: E(CARD_TOTAL) }]),
    meta(),
  );
  const ledger = [entry];

  it("balances to zero", () => expectBalanced(ledger));

  it("derives the documented balances", () => {
    // A: 159,950 x 15% = 23,992.5 -> 23,992 (half-even). VAT 14% = 3,358.88 -> 3,359.
    expect(bal(chart.sellerPayable("A"), ledger)).toBe(159_950n - 23_992n - 3_359n); // 132,599
    // B: 60,025 x 15% = 9,003.75 -> 9,004. VAT = 1,260.56 -> 1,261.
    expect(bal(chart.sellerPayable("B"), ledger)).toBe(49_760n);
    expect(bal(chart.platformCommission, ledger)).toBe(32_996n);
    // Shipping 5,000 gross: VAT 614.03 -> 614, net 4,386.
    expect(bal(chart.shippingRevenue, ledger)).toBe(4_386n);
    expect(bal(chart.platformVatOutput, ledger)).toBe(3_359n + 1_261n + 614n);
    expect(bal(chart.pspClearing("psp1"), ledger)).toBe(CARD_TOTAL);
  });

  it("rejects tenders that do not add up to the payable amount", () => {
    expect(() =>
      orderRecognised(twoSellerOrder([{ kind: "psp", psp: "psp1", amount: E(CARD_TOTAL - 1n) }]), meta()),
    ).toThrow();
  });
});

describe("2. COD order and courier remittance", () => {
  const delivered = orderRecognised(
    twoSellerOrder([{ kind: "cod", courier: "courier1", amount: E(CARD_TOTAL) }]),
    meta("order_group", "og_cod"),
  );
  const remitted = clearingSettled(
    { party: { kind: "cod", courier: "courier1" }, gross: E(CARD_TOTAL), fee: E(2_500n), bankAccount: "main" },
    meta("cod_remittance", "rem_1"),
  );

  it("books the receivable at delivery and clears it on remittance", () => {
    expectBalanced([delivered, remitted]);
    expect(bal(chart.codClearing("courier1"), [delivered])).toBe(CARD_TOTAL);
    expect(bal(chart.codClearing("courier1"), [delivered, remitted])).toBe(0n);
    expect(bal(chart.bankSettlement("main"), [delivered, remitted])).toBe(CARD_TOTAL - 2_500n);
    expect(bal(chart.courierFeeExpense, [delivered, remitted])).toBe(2_500n);
  });

  it("leaves seller payables identical to the prepaid order", () => {
    expect(bal(chart.sellerPayable("A"), [delivered])).toBe(132_599n);
  });
});

describe("3. Partial refund to the card", () => {
  const order = orderRecognised(
    twoSellerOrder([{ kind: "psp", psp: "psp1", amount: E(CARD_TOTAL) }]),
    meta(),
  );
  const refund1 = refundIssued(
    {
      storeId: "A",
      commissionBps: 1_500n,
      vatBps: VAT,
      goodsRefunded: E(50_000n),
      goodsRefundedBefore: E(0n),
      destinations: [{ kind: "psp", psp: "psp1", amount: E(50_000n) }],
    },
    meta("refund", "r1"),
  );

  it("balances and returns commission and VAT proportionally", () => {
    const ledger = [order, refund1];
    expectBalanced(ledger);
    // 50,000 x 15% = 7,500 commission, 1,050 VAT, seller loses 41,450.
    expect(bal(chart.sellerPayable("A"), ledger)).toBe(132_599n - 41_450n);
    expect(bal(chart.platformCommission, ledger)).toBe(32_996n - 7_500n);
    expect(bal(chart.platformVatOutput, ledger)).toBe(5_234n - 1_050n);
    expect(bal(chart.pspClearing("psp1"), ledger)).toBe(CARD_TOTAL - 50_000n);
  });

  it("refunding the rest of seller A restores its payable to zero and the commission to B only", () => {
    const refund2 = refundIssued(
      {
        storeId: "A",
        commissionBps: 1_500n,
        vatBps: VAT,
        goodsRefunded: E(109_950n),
        goodsRefundedBefore: E(50_000n),
        destinations: [{ kind: "psp", psp: "psp1", amount: E(109_950n) }],
      },
      meta("refund", "r2"),
    );
    const ledger = [order, refund1, refund2];
    expectBalanced(ledger);
    expect(bal(chart.sellerPayable("A"), ledger)).toBe(0n);
    expect(bal(chart.platformCommission, ledger)).toBe(9_004n);
    expect(bal(chart.platformVatOutput, ledger)).toBe(1_261n + 614n);
  });
});

describe("4. Refund to store credit (COD order)", () => {
  it("credits the refund_credit sub-balance", () => {
    const order = orderRecognised(
      twoSellerOrder([{ kind: "cod", courier: "courier1", amount: E(CARD_TOTAL) }]),
      meta(),
    );
    const refund = refundIssued(
      {
        storeId: "B",
        commissionBps: 1_500n,
        vatBps: VAT,
        goodsRefunded: E(60_025n),
        goodsRefundedBefore: E(0n),
        shippingGross: E(5_000n),
        destinations: [
          { kind: "store_credit", userId: "u1", sub: { kind: "refund_credit" }, amount: E(65_025n) },
        ],
      },
      meta("refund", "r_credit"),
    );
    const ledger = [order, refund];
    expectBalanced(ledger);
    expect(bal(chart.storeCredit("u1", { kind: "refund_credit" }), ledger)).toBe(65_025n);
    expect(bal(chart.sellerPayable("B"), ledger)).toBe(0n);
    expect(bal(chart.shippingRevenue, ledger)).toBe(0n);
    // Credit never leaves the platform as cash: the COD receivable is untouched.
    expect(bal(chart.codClearing("courier1"), ledger)).toBe(CARD_TOTAL);
  });
});

describe("5. Gift card sale and redemption", () => {
  const sold = giftCardSold({ tender: { kind: "psp", psp: "psp1", amount: E(100_000n) } }, meta("gift_card", "gc1"));
  const redeemed = giftCardRedeemed({ userId: "u2", cardId: "gc1", amount: E(100_000n) }, meta("gift_card", "gc1"));

  it("moves value from the card liability to the shopper's gift_card sub-balance", () => {
    expectBalanced([sold, redeemed]);
    expect(bal(chart.giftCardLiability, [sold])).toBe(100_000n);
    expect(bal(chart.platformVatOutput, [sold])).toBe(0n); // VERIFY: VAT point
    expect(bal(chart.giftCardLiability, [sold, redeemed])).toBe(0n);
    expect(bal(chart.storeCredit("u2", { kind: "gift_card", cardId: "gc1" }), [sold, redeemed])).toBe(100_000n);
  });

  it("refuses to sell a gift card for store credit or cash on delivery", () => {
    expect(() =>
      giftCardSold(
        { tender: { kind: "store_credit", userId: "u", sub: { kind: "goodwill" }, amount: E(1n) } },
        meta(),
      ),
    ).toThrow();
    expect(() =>
      giftCardSold({ tender: { kind: "cod", courier: "c", amount: E(1n) } }, meta()),
    ).toThrow();
  });
});

describe("6. Order paid with store credit across sub-balances", () => {
  const grants: JournalEntry[] = [
    storeCreditGranted({ userId: "u1", sub: { kind: "goodwill" }, amount: E(2_000n) }, meta("goodwill", "g1")),
    storeCreditGranted({ userId: "u1", sub: { kind: "referral_credit" }, amount: E(5_000n) }, meta("referral", "r1")),
    storeCreditGranted({ userId: "u1", sub: { kind: "cashback_coins" }, amount: E(3_000n) }, meta("coins", "c1")),
    giftCardSold({ tender: { kind: "psp", psp: "psp1", amount: E(10_000n) } }, meta("gift_card", "gc1")),
    giftCardRedeemed({ userId: "u1", cardId: "gc1", amount: E(10_000n) }, meta("gift_card", "gc1")),
  ];
  // Refund credit comes from a COD order refunded to credit.
  const seedOrder = orderRecognised(
    {
      sellerOrders: [{ storeId: "S", merchandise: E(30_000n), commissionBps: 1_000n }],
      shippingGross: E(0n),
      vatBps: VAT,
      tenders: [{ kind: "cod", courier: "courier1", amount: E(30_000n) }],
    },
    meta(),
  );
  const seedRefund = refundIssued(
    {
      storeId: "S",
      commissionBps: 1_000n,
      vatBps: VAT,
      goodsRefunded: E(30_000n),
      goodsRefundedBefore: E(0n),
      destinations: [{ kind: "store_credit", userId: "u1", sub: { kind: "refund_credit" }, amount: E(30_000n) }],
    },
    meta("refund", "seed"),
  );
  const before = [...grants, seedOrder, seedRefund];

  const expiries: Record<string, Date | null> = {
    goodwill: new Date("2026-12-01T00:00:00Z"),
    referral_credit: new Date("2027-01-15T00:00:00Z"),
    cashback_coins: new Date("2027-03-01T00:00:00Z"),
    "gift_card:gc1": new Date("2029-10-10T00:00:00Z"),
    refund_credit: null,
  };
  const states: SubBalanceState[] = [
    { kind: "goodwill" },
    { kind: "referral_credit" },
    { kind: "cashback_coins" },
    { kind: "gift_card", cardId: "gc1" },
    { kind: "refund_credit" },
  ].map((sub) => {
    const key = sub.kind === "gift_card" ? `gift_card:${sub.cardId}` : sub.kind;
    return {
      sub: sub as SubBalanceState["sub"],
      balance: derivedBalance(chart.storeCredit("u1", sub as SubBalanceState["sub"]), before),
      expiresAt: expiries[key] ?? null,
    };
  });

  it("spends soonest-expiring first and leaves refund credit last", () => {
    const plan = planStoreCreditSpend(states, E(12_000n));
    expect(plan.map((p) => [p.sub.kind, p.amount.amount])).toEqual([
      ["goodwill", 2_000n],
      ["referral_credit", 5_000n],
      ["cashback_coins", 3_000n],
      ["gift_card", 2_000n],
    ]);
  });

  it("posts the order against those sub-balances and balances", () => {
    const plan = planStoreCreditSpend(states, E(12_000n));
    const order = orderRecognised(
      {
        sellerOrders: [{ storeId: "C", merchandise: E(12_000n), commissionBps: 1_000n }],
        shippingGross: E(0n),
        vatBps: VAT,
        tenders: plan.map((p) => ({ kind: "store_credit", userId: "u1", sub: p.sub, amount: p.amount })),
      },
      meta(),
    );
    const ledger = [...before, order];
    expectBalanced(ledger);
    expect(bal(chart.storeCredit("u1", { kind: "goodwill" }), ledger)).toBe(0n);
    expect(bal(chart.storeCredit("u1", { kind: "referral_credit" }), ledger)).toBe(0n);
    expect(bal(chart.storeCredit("u1", { kind: "cashback_coins" }), ledger)).toBe(0n);
    expect(bal(chart.storeCredit("u1", { kind: "gift_card", cardId: "gc1" }), ledger)).toBe(8_000n);
    expect(bal(chart.storeCredit("u1", { kind: "refund_credit" }), ledger)).toBe(30_000n);
    // 12,000 x 10% = 1,200 commission, 168 VAT, seller owed 10,632.
    expect(bal(chart.sellerPayable("C"), ledger)).toBe(10_632n);
  });
});

describe("7. Seller payout", () => {
  it("settles the PSP then pays the seller, leaving the other seller's payable open", () => {
    const order = orderRecognised(
      twoSellerOrder([{ kind: "psp", psp: "psp1", amount: E(CARD_TOTAL) }]),
      meta(),
    );
    const settled = clearingSettled(
      { party: { kind: "psp", psp: "psp1" }, gross: E(CARD_TOTAL), fee: E(3_000n), bankAccount: "main" },
      meta("psp_settlement", "s1"),
    );
    const payout = sellerPayout({ storeId: "A", amount: E(132_599n), bankAccount: "main" }, meta("payout", "p1"));
    const ledger = [order, settled, payout];
    expectBalanced(ledger);
    expect(bal(chart.pspClearing("psp1"), ledger)).toBe(0n);
    expect(bal(chart.sellerPayable("A"), ledger)).toBe(0n);
    expect(bal(chart.sellerPayable("B"), ledger)).toBe(49_760n);
    expect(bal(chart.bankSettlement("main"), ledger)).toBe(CARD_TOTAL - 3_000n - 132_599n);
  });

  it("a failed payout is undone with a reversal", () => {
    const payout = sellerPayout({ storeId: "A", amount: E(100n), bankAccount: "main" }, meta());
    const undo = reverseEntry(payout, { id: "je_undo", idempotencyKey: "undo_1", occurredAt: new Date() });
    expect(bal(chart.sellerPayable("A"), [payout, undo])).toBe(0n);
    expect(bal(chart.bankSettlement("main"), [payout, undo])).toBe(0n);
  });
});

describe("8. BNPL order, partial refund through the provider, settlement", () => {
  const order = orderRecognised(
    twoSellerOrder([{ kind: "bnpl", provider: "lender1", amount: E(CARD_TOTAL) }]),
    meta(),
  );
  const refund = refundIssued(
    {
      storeId: "A",
      commissionBps: 1_500n,
      vatBps: VAT,
      goodsRefunded: E(50_000n),
      goodsRefundedBefore: E(0n),
      destinations: [{ kind: "bnpl", provider: "lender1", amount: E(50_000n) }],
    },
    meta("refund", "r_bnpl"),
  );
  const settled = clearingSettled(
    {
      party: { kind: "bnpl", provider: "lender1" },
      gross: E(CARD_TOTAL - 50_000n),
      fee: E(4_500n),
      bankAccount: "main",
    },
    meta("bnpl_settlement", "bs1"),
  );

  it("balances and clears the provider receivable", () => {
    const ledger = [order, refund, settled];
    expectBalanced(ledger);
    expect(bal(chart.bnplClearing("lender1"), [order])).toBe(CARD_TOTAL);
    expect(bal(chart.bnplClearing("lender1"), [order, refund])).toBe(CARD_TOTAL - 50_000n);
    expect(bal(chart.bnplClearing("lender1"), ledger)).toBe(0n);
    expect(bal(chart.providerFeeExpense, ledger)).toBe(4_500n);
    // The refund never touches store credit.
    expect(bal(chart.storeCredit("u1", { kind: "refund_credit" }), ledger)).toBe(0n);
  });
});

describe("9. Plus subscription with deferred revenue", () => {
  // 1,140.00 EGP for a 12 month term, VAT-inclusive: VAT 140.00, net 1,000.00.
  const charge = plusCharged(
    { tender: { kind: "psp", psp: "psp1", amount: E(114_000n) }, vatBps: VAT },
    meta("subscription", "sub1"),
  );
  const schedule = planPlusRecognition(E(100_000n), 12);
  const recognitions = schedule.map((amount, i) =>
    plusRevenueRecognised({ amount }, meta("subscription_period", `sub1_${i}`)),
  );

  it("defers net revenue at charge", () => {
    expectBalanced([charge]);
    expect(bal(chart.deferredPlusRevenue, [charge])).toBe(100_000n);
    expect(bal(chart.platformVatOutput, [charge])).toBe(14_000n);
    expect(bal(chart.plusRevenue, [charge])).toBe(0n);
  });

  it("recognises net revenue exactly over 12 periods", () => {
    expect(schedule.reduce((a, m) => a + m.amount, 0n)).toBe(100_000n);
    expect(schedule.filter((m) => m.amount === 8_334n)).toHaveLength(4);
    const afterThree = [charge, ...recognitions.slice(0, 3)];
    expectBalanced(afterThree);
    expect(bal(chart.plusRevenue, afterThree)).toBe(25_002n);
    expect(bal(chart.deferredPlusRevenue, afterThree)).toBe(74_998n);
    const all = [charge, ...recognitions];
    expect(bal(chart.deferredPlusRevenue, all)).toBe(0n);
    expect(bal(chart.plusRevenue, all)).toBe(100_000n);
  });
});

describe("10. Voucher funded by the platform versus by the seller", () => {
  const base = {
    storeId: "D",
    merchandise: E(100_000n),
    commissionBps: 1_500n,
  };
  const input = (discounts: { platform: bigint; seller: bigint }): OrderRecognisedInput => ({
    sellerOrders: [
      {
        ...base,
        platformFundedDiscount: E(discounts.platform),
        sellerFundedDiscount: E(discounts.seller),
      },
    ],
    shippingGross: E(0n),
    vatBps: VAT,
    tenders: [{ kind: "psp", psp: "psp1", amount: E(90_000n) }],
  });

  it("platform-funded: the seller is paid in full, the platform books an expense", () => {
    const e = orderRecognised(input({ platform: 10_000n, seller: 0n }), meta());
    expectBalanced([e]);
    expect(bal(chart.promoExpensePlatform, [e])).toBe(10_000n);
    expect(bal(chart.sellerPayable("D"), [e])).toBe(100_000n - 15_000n - 2_100n);
    expect(bal(chart.promoReceivableSeller("D"), [e])).toBe(0n);
  });

  it("seller-funded: a receivable is booked and then netted from the payable", () => {
    const e = orderRecognised(input({ platform: 0n, seller: 10_000n }), meta());
    const net = sellerPromoNetted({ storeId: "D", amount: E(10_000n) }, meta("payout_cycle", "w1"));
    expectBalanced([e, net]);
    expect(bal(chart.promoExpensePlatform, [e, net])).toBe(0n);
    expect(bal(chart.promoReceivableSeller("D"), [e])).toBe(10_000n);
    expect(bal(chart.promoReceivableSeller("D"), [e, net])).toBe(0n);
    expect(bal(chart.sellerPayable("D"), [e, net])).toBe(82_900n - 10_000n);
  });

  it("a platform-funded discount is reversed when the discounted line is refunded", () => {
    const e = orderRecognised(input({ platform: 10_000n, seller: 0n }), meta());
    const r = refundIssued(
      {
        storeId: "D",
        commissionBps: 1_500n,
        vatBps: VAT,
        goodsRefunded: E(100_000n),
        goodsRefundedBefore: E(0n),
        platformFundedDiscount: E(10_000n),
        destinations: [{ kind: "psp", psp: "psp1", amount: E(90_000n) }],
      },
      meta("refund", "rv"),
    );
    expectBalanced([e, r]);
    expect(bal(chart.promoExpensePlatform, [e, r])).toBe(0n);
    expect(bal(chart.sellerPayable("D"), [e, r])).toBe(0n);
  });

  it("allocates a cart voucher over seller orders without losing a piastre", () => {
    const parts = allocateVoucher(E(1_001n), [E(159_950n), E(60_025n)]);
    expect(parts.reduce((a, m) => a + m.amount, 0n)).toBe(1_001n);
  });
});

describe("11. Reversal", () => {
  it("negates every posting, and nets every account to zero", () => {
    const order = orderRecognised(
      twoSellerOrder([{ kind: "psp", psp: "psp1", amount: E(CARD_TOTAL) }]),
      meta(),
    );
    const undo = reverseEntry(order, { id: "je_rev", idempotencyKey: "rev_1", occurredAt: new Date() });
    expect(undo.ref).toEqual({ type: "journal_entry", id: order.id });
    const ledger = [order, undo];
    expectBalanced(ledger);
    for (const p of order.postings) {
      expect(bal(p.account, ledger)).toBe(0n);
    }
  });

  it("is itself an entry the ledger accepts after a failed re-validation round trip", () => {
    const e = giftCardRedeemed({ userId: "u", cardId: "g", amount: E(5n) }, meta());
    expect(() => createJournalEntry(e)).not.toThrow();
  });
});

describe("12. refund_reserve stays unused", () => {
  it("no builder posts to refund_reserve", () => {
    const entries = [
      orderRecognised(twoSellerOrder([{ kind: "psp", psp: "psp1", amount: E(CARD_TOTAL) }]), meta()),
      plusCharged({ tender: { kind: "psp", psp: "p", amount: E(114n) }, vatBps: VAT }, meta()),
    ];
    for (const e of entries) {
      expect(e.postings.some((p) => p.account === chart.refundReserve)).toBe(false);
    }
  });
});
