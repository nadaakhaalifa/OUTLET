import { withTestDb } from "@outlet/db/testing";
import { allocate, fraction, money, percentOf } from "@outlet/money";
import { describe, expect, it } from "vitest";
import { Ledger } from "../src/index.js";
import { MARKET, acc, counts, cr, dr, draftOf } from "./fixtures.js";
import type { Line, Step } from "./fixtures.js";

/**
 * Executable form of docs/specs/ledger-chart-of-accounts.md section 4 (all amounts are development fixtures in piastres).
 * Postings are built through @outlet/money (percentOf / fraction / allocate) so the spec's formulas are exercised,
 * and the expected balances are the spec's literal numbers. Balances are signed: debit positive, credit negative.
 */
const money_ = (n: bigint) => money(n, "EGP");
const commission = (base: bigint): bigint => percentOf(money_(base), 1500n).amountMinor;
const vatOnCommission = (c: bigint): bigint => percentOf(money_(c), 1400n).amountMinor;
const deliveryVat = (gross: bigint): bigint => fraction(money_(gross), 1400n, 11400n).amountMinor;

const PSP = acc("psp_clearing", "paymob");
const COD = acc("cod_clearing", "bosta");
const BNPL = acc("bnpl_clearing", "valu");
const BANK_C = acc("bank_collections", "main");
const BANK_O = acc("bank_operating", "main");
const VAT = acc("platform_vat_output");
const COMM = acc("commission_revenue");
const SHIP = acc("shipping_revenue");
const pend = (s: string): string => acc("seller_pending", s);
const avail = (s: string): string => acc("seller_available", s);
const COURIER_PAY = acc("courier_payable", "bosta");

interface Scenario {
  readonly name: string;
  readonly steps: readonly Step[];
  /** Spec-literal signed balances (debit positive). Accounts not listed are not asserted except via the trial balance. */
  readonly expected: Readonly<Record<string, bigint>>;
}

const step = (kind: string, key: string, lines: readonly Line[]): Step => ({ kind, key, lines });

// 4.1 -----------------------------------------------------------------------------------------------------------
const cA = commission(249_900n), vA = vatOnCommission(cA);
const cB = commission(89_950n), vB = vatOnCommission(cB);
const cC = commission(45_000n), vC = vatOnCommission(cC);
const dVat = deliveryVat(6_000n);
const order41: Step = step("order_recognised", "order_paid:og1", [
  dr(PSP, 249_900n + 89_950n + 45_000n + 12_000n),
  cr(pend("A"), 249_900n - cA - vA),
  cr(pend("B"), 89_950n - cB - vB),
  cr(pend("C"), 45_000n - cC - vC),
  cr(COMM, cA + cB + cC),
  cr(VAT, vA + vB + vC + dVat + dVat),
  cr(SHIP, 6_000n - dVat + 6_000n - dVat),
]);
const bal41 = {
  [PSP]: 396_850n,
  [pend("A")]: -207_167n,
  [pend("B")]: -74_569n,
  [pend("C")]: -37_305n,
  [COMM]: -57_727n,
  [VAT]: -9_556n,
  [SHIP]: -10_526n,
};

// 4.5 / 4.6 / 4.7 building blocks ----------------------------------------------------------------------------------
const partialReject: Step = step("refund_issued", "refund:b-line2", [
  dr(pend("B"), 30_000n - (commission(89_950n) - commission(59_950n)) - (vatOnCommission(cB) - vatOnCommission(commission(59_950n)))),
  dr(COMM, cB - commission(59_950n)),
  dr(VAT, vB - vatOnCommission(commission(59_950n))),
  cr(PSP, 30_000n),
]);
const retComm = cA - commission(200_000n); // 7,485
const retVat = vA - vatOnCommission(commission(200_000n)); // 1,048
const feeVat = deliveryVat(4_000n); // 491
const returnLines = (refundTo: Line): readonly Line[] => [
  dr(pend("A"), 49_900n - retComm - retVat),
  dr(COMM, retComm),
  dr(VAT, retVat),
  refundTo,
  cr(SHIP, 4_000n - feeVat),
  cr(VAT, feeVat),
];

// 4.8 ---------------------------------------------------------------------------------------------------------------
const cBn = commission(150_000n), vBn = vatOnCommission(cBn);
const bnplApproved = step("order_recognised", "order_bnpl:c1", [
  dr(BNPL, 156_000n),
  cr(pend("C"), 150_000n - cBn - vBn),
  cr(COMM, cBn),
  cr(VAT, vBn + dVat),
  cr(SHIP, 6_000n - dVat),
]);

// 4.9 ---------------------------------------------------------------------------------------------------------------
const planVat = percentOf(money_(100_000n), 1400n).amountMinor;

// 4.12 --------------------------------------------------------------------------------------------------------------
const cbOpen = step("dispute_opened", "dispute:open", [dr(acc("disputes_in_progress", "paymob"), 51_000n), dr(acc("psp_fee_expense"), 1_500n), cr(PSP, 52_500n)]);
const DISP = acc("disputes_in_progress", "paymob");

const scenarios: readonly Scenario[] = [
  {
    name: "4.1 multi-store prepaid order (3 stores, card)",
    steps: [order41],
    expected: bal41,
  },
  {
    name: "4.1 PSP settlement, model (b): platform collects",
    steps: [order41, step("clearing_settled", "psp_settle:b", [dr(BANK_C, 384_944n), dr(acc("psp_fee_expense"), 11_906n), cr(PSP, 396_850n)])],
    expected: { ...bal41, [PSP]: 0n, [BANK_C]: 384_944n, [acc("psp_fee_expense")]: 11_906n },
  },
  {
    name: "4.1 PSP settlement, model (a): PSP splits to sellers",
    steps: [
      order41,
      step("clearing_settled", "psp_settle:a", [
        dr(BANK_O, 65_903n),
        dr(acc("psp_fee_expense"), 11_906n),
        dr(pend("A"), 207_167n),
        dr(pend("B"), 74_569n),
        dr(pend("C"), 37_305n),
        cr(PSP, 396_850n),
      ]),
    ],
    expected: { [PSP]: 0n, [BANK_O]: 65_903n, [pend("A")]: 0n, [pend("B")]: 0n, [pend("C")]: 0n },
  },
  {
    name: "4.2 voucher platform-funded",
    steps: [
      step("order_recognised", "v:platform", [
        dr(PSP, 90_000n),
        dr(acc("promo_expense_platform"), 10_000n),
        cr(pend("D"), 100_000n - commission(100_000n) - vatOnCommission(commission(100_000n))),
        cr(COMM, commission(100_000n)),
        cr(VAT, vatOnCommission(commission(100_000n))),
      ]),
    ],
    expected: { [PSP]: 90_000n, [acc("promo_expense_platform")]: 10_000n, [pend("D")]: -82_900n, [COMM]: -15_000n, [VAT]: -2_100n },
  },
  {
    name: "4.2 voucher seller-funded",
    steps: [
      step("order_recognised", "v:seller", [
        dr(PSP, 90_000n),
        cr(pend("D"), 90_000n - commission(90_000n) - vatOnCommission(commission(90_000n))),
        cr(COMM, commission(90_000n)),
        cr(VAT, vatOnCommission(commission(90_000n))),
      ]),
    ],
    expected: { [PSP]: 90_000n, [pend("D")]: -74_610n, [COMM]: -13_500n, [VAT]: -1_890n, [acc("promo_expense_platform")]: 0n },
  },
  {
    name: "4.3 COD delivered, then courier remittance",
    steps: [
      step("order_delivered_cod", "cod:a1", [
        dr(COD, 126_000n),
        cr(pend("A"), 120_000n - commission(120_000n) - vatOnCommission(commission(120_000n))),
        cr(COMM, commission(120_000n)),
        cr(VAT, vatOnCommission(commission(120_000n)) + dVat),
        cr(SHIP, 6_000n - dVat),
        dr(acc("courier_cost_expense"), 5_500n),
        cr(COURIER_PAY, 5_500n),
      ]),
      step("courier_remitted", "cod:a1:remit", [dr(BANK_C, 120_500n), dr(COURIER_PAY, 5_500n), cr(COD, 126_000n)]),
    ],
    expected: {
      [COD]: 0n,
      [COURIER_PAY]: 0n,
      [BANK_C]: 120_500n,
      [pend("A")]: -99_480n,
      [COMM]: -18_000n,
      [VAT]: -3_257n,
      [SHIP]: -5_263n,
      [acc("courier_cost_expense")]: 5_500n,
    },
  },
  {
    name: "4.4 COD refused (RTO), case 1 platform-funded, case 2 seller pays",
    steps: [
      step("courier_cost_accrued", "rto:cost", [dr(acc("courier_cost_expense"), 4_500n + 3_000n), cr(COURIER_PAY, 7_500n)]),
      step("recharge_issued", "rto:recharge", [
        dr(avail("A"), 7_500n + percentOf(money_(7_500n), 1400n).amountMinor),
        cr(acc("recharge_revenue"), 7_500n),
        cr(VAT, percentOf(money_(7_500n), 1400n).amountMinor),
      ]),
    ],
    expected: {
      [acc("courier_cost_expense")]: 7_500n,
      [COURIER_PAY]: -7_500n,
      [avail("A")]: 8_550n,
      [acc("recharge_revenue")]: -7_500n,
      [VAT]: -1_050n,
      [COMM]: 0n,
      [pend("A")]: 0n,
    },
  },
  {
    name: "4.5 partial seller rejection -> partial refund (commission and VAT by differencing)",
    steps: [order41, partialReject],
    expected: { ...bal41, [pend("B")]: -49_699n, [COMM]: -57_727n + 4_500n, [VAT]: -9_556n + 630n, [PSP]: 396_850n - 30_000n },
  },
  {
    name: "4.6 return refunded to the card",
    steps: [order41, step("refund_issued", "refund:a-return", returnLines(cr(PSP, 45_900n)))],
    expected: {
      [pend("A")]: -207_167n + 41_367n,
      [COMM]: -57_727n + 7_485n,
      [VAT]: -9_556n + 1_048n - 491n,
      [SHIP]: -10_526n - 3_509n,
      [PSP]: 396_850n - 45_900n,
    },
  },
  {
    name: "4.7 refund to store credit, then spent on store D",
    steps: [
      order41,
      step("refund_issued", "refund:a-credit", returnLines(cr(acc("store_credit", "usr_1", "refund_credit"), 45_900n))),
      step("store_credit_spent", "spend:usr1:d", [
        dr(acc("store_credit", "usr_1", "refund_credit"), 45_900n),
        cr(pend("D"), 45_900n - commission(45_900n) - vatOnCommission(commission(45_900n))),
        cr(COMM, commission(45_900n)),
        cr(VAT, vatOnCommission(commission(45_900n))),
      ]),
    ],
    expected: {
      [acc("store_credit", "usr_1", "refund_credit")]: 0n,
      [pend("D")]: -38_051n,
      [COMM]: -57_727n + 7_485n - 6_885n,
      [VAT]: -9_556n + 1_048n - 491n - 964n,
      [PSP]: 396_850n,
    },
  },
  {
    name: "4.8 BNPL order, settlement, whole-order cancellation through the provider",
    steps: [
      bnplApproved,
      step("clearing_settled", "bnpl:settle", [dr(BANK_C, 148_200n), dr(acc("bnpl_fee_expense"), 7_800n), cr(BNPL, 156_000n)]),
      step("refund_issued", "bnpl:cancel", [
        dr(pend("C"), 124_350n),
        dr(COMM, 22_500n),
        dr(VAT, vBn + dVat),
        dr(SHIP, 6_000n - dVat),
        cr(BNPL, 156_000n),
      ]),
    ],
    expected: {
      [BNPL]: -156_000n,
      [pend("C")]: 0n,
      [COMM]: 0n,
      [VAT]: 0n,
      [SHIP]: 0n,
      [BANK_C]: 148_200n,
      [acc("bnpl_fee_expense")]: 7_800n,
      [acc("store_credit", "usr_1", "refund_credit")]: 0n,
    },
  },
  {
    name: "4.9 seller plan fee with VAT (card), recognition, balance deduction",
    steps: [
      step("plan_charged", "plan:a:nov:card", [dr(PSP, 100_000n + planVat), cr(acc("deferred_revenue", "seller_plans"), 100_000n), cr(VAT, planVat)]),
      step("plan_charged", "plan:b:nov:balance", [dr(avail("B"), 114_000n), cr(acc("deferred_revenue", "seller_plans"), 100_000n), cr(VAT, 14_000n)]),
      step("revenue_recognised", "plan:nov:recognise", [dr(acc("deferred_revenue", "seller_plans"), 200_000n), cr(acc("seller_plan_revenue"), 200_000n)]),
    ],
    expected: { [PSP]: 114_000n, [avail("B")]: 114_000n, [acc("deferred_revenue", "seller_plans")]: 0n, [VAT]: -28_000n, [acc("seller_plan_revenue")]: -200_000n },
  },
  {
    name: "4.11 weekly payout with negative-balance netting",
    steps: [
      order41,
      partialReject,
      step("refund_issued", "refund:b-postclose", [dr(avail("B"), 16_580n), dr(COMM, 3_000n), dr(VAT, 420n), cr(PSP, 20_000n)]),
      step("line_closed", "close:b", [dr(pend("B"), 49_699n), cr(avail("B"), 49_699n)]),
      step("payout_sent", "payout:p1", [dr(avail("B"), 33_119n), cr(acc("payouts_in_transit"), 33_119n)]),
      step("payout_settled", "payout:p1:settled", [dr(acc("payouts_in_transit"), 33_119n), cr(BANK_C, 33_119n)]),
    ],
    expected: { [avail("B")]: 0n, [pend("B")]: 0n, [acc("payouts_in_transit")]: 0n, [BANK_C]: -33_119n },
  },
];

const chargebackOutcomes: readonly Scenario[] = [
  { name: "4.12 chargeback won", steps: [order41, cbOpen, step("dispute_resolved", "dispute:won", [dr(PSP, 51_000n), cr(DISP, 51_000n)])], expected: { [DISP]: 0n, [acc("psp_fee_expense")]: 1_500n, [PSP]: 396_850n - 52_500n + 51_000n } },
  {
    name: "4.12 chargeback lost, seller liable",
    steps: [
      order41,
      cbOpen,
      step("dispute_resolved", "dispute:lost-seller", [
        dr(avail("C"), 37_305n),
        dr(COMM, 6_750n),
        dr(VAT, vC + dVat),
        dr(SHIP, 6_000n - dVat),
        cr(DISP, 51_000n),
      ]),
    ],
    expected: { [DISP]: 0n, [avail("C")]: 37_305n, [COMM]: -57_727n + 6_750n, [VAT]: -9_556n + 1_682n, [SHIP]: -10_526n + 5_263n },
  },
  {
    name: "4.12 chargeback lost, platform liable",
    steps: [order41, cbOpen, step("dispute_resolved", "dispute:lost-platform", [dr(acc("chargeback_loss_expense"), 51_000n), cr(DISP, 51_000n)])],
    expected: { [DISP]: 0n, [acc("chargeback_loss_expense")]: 51_000n },
  },
];

describe("worked examples (spec section 4)", () => {
  it.each([...scenarios, ...chargebackOutcomes])("$name", async ({ steps, expected }) => {
    await withTestDb(async (client) => {
      for (const s of steps) {
        const r = await client.transaction((tx) => Ledger.post(tx, draftOf(s)));
        expect(r.replayed).toBe(false);
      }
      for (const [code, want] of Object.entries(expected)) {
        expect(`${code} ${(await Ledger.balance(client, code)).amountMinor.toString()}`).toBe(`${code} ${want.toString()}`);
      }
      expect((await Ledger.trialBalance(client, MARKET, "EGP")).amountMinor).toBe(0n);
      expect(await Ledger.verifyChain(client, MARKET)).toMatchObject({ ok: true, entries: steps.length });
      expect((await counts(client)).outbox).toBe(steps.length);
    });
  });

  it("4.1 spec working: the formulas reproduce the literal figures", () => {
    expect([cA, vA, cB, vB, cC, vC, dVat]).toEqual([37_485n, 5_248n, 13_492n, 1_889n, 6_750n, 945n, 737n]);
  });

  it("4.11 FAILED payout: a reversing entry puts the money back in seller_available", async () => {
    await withTestDb(async (client) => {
      await client.transaction((tx) => Ledger.post(tx, draftOf(step("line_closed", "close:b", [dr(pend("B"), 49_699n), cr(avail("B"), 49_699n)]))));
      const sent = await client.transaction((tx) =>
        Ledger.post(tx, draftOf(step("payout_sent", "payout:p2", [dr(avail("B"), 49_699n), cr(acc("payouts_in_transit"), 49_699n)]))),
      );
      await client.transaction((tx) => Ledger.reverse(tx, sent.entryId, { idempotencyKey: "payout:p2:failed", reason: "bank rejected" }));
      expect((await Ledger.balance(client, avail("B"))).amountMinor).toBe(-49_699n);
      expect((await Ledger.balance(client, acc("payouts_in_transit"))).amountMinor).toBe(0n);
    });
  });

  it("4.9 annual plan: 1,000,000 net over 12 periods by largest remainder, deferred revenue ends at zero", async () => {
    const parts = allocate(money_(1_000_000n), Array<bigint>(12).fill(1n)).map((m) => m.amountMinor);
    expect(parts).toEqual([...Array<bigint>(4).fill(83_334n), ...Array<bigint>(8).fill(83_333n)]);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(1_000_000n);
    await withTestDb(async (client) => {
      const vat = percentOf(money_(1_000_000n), 1400n).amountMinor;
      await client.transaction((tx) =>
        Ledger.post(tx, draftOf(step("plan_charged", "plan:annual", [dr(PSP, 1_000_000n + vat), cr(acc("deferred_revenue", "seller_plans"), 1_000_000n), cr(VAT, vat)]))),
      );
      for (const [i, p] of parts.entries()) {
        await client.transaction((tx) =>
          Ledger.post(tx, draftOf(step("revenue_recognised", `plan:annual:p${String(i)}`, [dr(acc("deferred_revenue", "seller_plans"), p), cr(acc("seller_plan_revenue"), p)]))),
        );
      }
      expect((await Ledger.balance(client, acc("deferred_revenue", "seller_plans"))).amountMinor).toBe(0n);
      expect((await Ledger.balance(client, acc("seller_plan_revenue"))).amountMinor).toBe(-1_000_000n);
      expect((await Ledger.trialBalance(client, MARKET, "EGP")).amountMinor).toBe(0n);
    });
  });

  it("4.10 e-invoice is a document derived from the ledger: invoice VAT equals the posted seller-supply VAT (I14)", async () => {
    const orderA = step("order_recognised", "inv:order-a", [
      dr(PSP, 249_900n),
      cr(pend("A"), 249_900n - cA - vA),
      cr(COMM, cA),
      cr(VAT, vA),
    ]);
    const recharge = step("recharge_issued", "inv:recharge", [dr(avail("A"), 8_550n), cr(acc("recharge_revenue"), 7_500n), cr(VAT, 1_050n)]);
    const ret = step("refund_issued", "inv:return", returnLines(cr(PSP, 45_900n)));
    const plan = step("plan_charged", "inv:plan", [dr(avail("A"), 114_000n), cr(acc("deferred_revenue", "seller_plans"), 100_000n), cr(VAT, 14_000n)]);
    const invoice = [
      { net: cA, vat: vA },
      { net: -retComm, vat: -retVat },
      { net: 7_500n, vat: 1_050n },
      { net: 100_000n, vat: 14_000n },
    ];
    expect(invoice.reduce((a, l) => a + l.net, 0n)).toBe(137_500n);
    const invoiceVat = invoice.reduce((a, l) => a + l.vat, 0n);
    expect(invoiceVat).toBe(19_250n);
    await withTestDb(async (client) => {
      for (const s of [orderA, recharge, ret, plan]) await client.transaction((tx) => Ledger.post(tx, draftOf(s)));
      // The return entry also carries the shopper-facing return-fee VAT (491), which is not a supply to the seller.
      const postedVat = -(await Ledger.balance(client, VAT)).amountMinor - feeVat;
      expect(postedVat).toBe(invoiceVat);
    });
  });

  it.each([
    ["commission 89,950 x 15% (tie to even)", () => commission(89_950n), 13_492n],
    ["commission 59,950 x 15% (tie to even)", () => commission(59_950n), 8_992n],
    ["VAT on commission 2,625 (tie to even)", () => vatOnCommission(2_625n), 368n],
    ["VAT on commission 13,492 (nearest)", () => vatOnCommission(13_492n), 1_889n],
    ["delivery VAT 6,000 x 14/114", () => deliveryVat(6_000n), 737n],
    ["commission 10,003 x 15%", () => commission(10_003n), 1_500n],
  ])("4.13 rounding: %s", (_n, fn, want) => {
    expect(fn()).toBe(want);
  });

  it("4.13 aggregation trap: VAT per event 2,257 vs VAT on the sum 2,256", () => {
    expect(vatOnCommission(13_492n) + vatOnCommission(2_625n)).toBe(2_257n);
    expect(vatOnCommission(13_492n + 2_625n)).toBe(2_256n);
  });

  it("4.13 voucher allocation by largest remainder posts as one balanced entry", async () => {
    const shares = allocate(money_(10_000n), [249_900n, 89_950n, 45_000n]).map((m) => m.amountMinor);
    expect(shares).toEqual([6_494n, 2_337n, 1_169n]);
    await withTestDb(async (client) => {
      await client.transaction((tx) =>
        Ledger.post(
          tx,
          draftOf(step("order_recognised", "alloc:voucher", [dr(acc("promo_expense_platform"), 10_000n), cr(pend("A"), shares[0] ?? 0n), cr(pend("B"), shares[1] ?? 0n), cr(pend("C"), shares[2] ?? 0n)])),
        ),
      );
      expect((await Ledger.trialBalance(client, MARKET, "EGP")).amountMinor).toBe(0n);
    });
  });
});
