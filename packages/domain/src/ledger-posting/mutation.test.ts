import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { chart, derivedBalance } from "../chart-of-accounts";
import { createJournalEntry, type JournalEntry } from "../ledger";
import { money, type Money } from "../money";
import { PostingConflictError, RefundExceedsOriginalError } from "./errors";
import { canonicalPayload } from "./fingerprint";
import { GENESIS_HASH, chainPayload, nextHash, verifyChain, type ChainedEntry, type Sha256Hex } from "./hash-chain";
import { buildIntegrityReport, storeCreditDrift } from "./integrity";
import { planRefund, voucherRelease, type RefundPlanInput } from "./refund-allocation";
import { reversesOf, reversalKey } from "./reversal";
import { buildEntry, keyOf, planOrder, type OrderCommandBase, type PostingCommand } from "./templates";

const E = (n: bigint): Money => money(n);
const sha: Sha256Hex = (s) => createHash("sha256").update(s).digest("hex");
const T0 = new Date("2026-10-11T10:00:00Z");
const meta = { id: "je_x", occurredAt: T0 };
const bal = (account: string, e: JournalEntry): bigint => derivedBalance(account, [e]).amount;

// ---------------------------------------------------------------------------------------------
// Idempotency keys and references (spec: one stable key per business event)
// ---------------------------------------------------------------------------------------------

describe("idempotency key and reference per command", () => {
  const tender = { kind: "psp" as const, psp: "paymob", amount: E(1_000n) };
  const order: OrderCommandBase = {
    orderGroupId: "og9",
    storeOrders: [{ storeId: "A", merchandise: E(1_000n), commissionBps: 1_000n }],
    shippingGross: E(0n),
    vatBps: 1_400n,
    external: { kind: "psp", psp: "paymob" },
  };
  const refund: RefundPlanInput = {
    userId: "u1",
    storeId: "A",
    commissionBps: 1_000n,
    vatBps: 1_400n,
    lines: [{ lineId: "l1", gross: E(1_000n), refundedBefore: E(0n) }],
    items: [{ lineId: "l1", goods: E(1_000n) }],
    platformVoucher: E(0n),
    sellerVoucher: E(0n),
    tenders: [{ tender, refunded: E(0n) }],
    choice: "original",
  };
  const cases: readonly [PostingCommand, string, string, string][] = [
    [{ type: "order_paid", ...order }, "order_paid:og9", "order_group", "og9"],
    [{ type: "order_cod_confirmed", ...order }, "order_cod_confirmed:og9", "order_group", "og9"],
    [
      { type: "cod_collected", remittanceId: "r1", courier: "bosta", gross: E(10n), fee: E(1n), bankAccount: "b" },
      "cod_collected:r1",
      "cod_remittance",
      "r1",
    ],
    [
      { type: "bnpl_settled", settlementId: "s1", provider: "valu", gross: E(10n), fee: E(1n), bankAccount: "b" },
      "bnpl_settled:s1",
      "bnpl_settlement",
      "s1",
    ],
    [
      { type: "psp_settled", settlementId: "s2", psp: "paymob", gross: E(10n), fee: E(1n), bankAccount: "b" },
      "psp_settled:s2",
      "psp_settlement",
      "s2",
    ],
    [{ type: "refund", refundId: "rf1", ...refund }, "refund:rf1:A", "refund", "rf1"],
    [{ type: "seller_payout", payoutId: "p1", storeId: "A", amount: E(5n), bankAccount: "b" }, "seller_payout:p1", "payout", "p1"],
    [{ type: "seller_promo_netted", ref: "promo1", storeId: "A", amount: E(5n) }, "seller_promo_netted:promo1:A", "seller_promo", "promo1"],
    [
      { type: "store_credit_issue", grantId: "g1", userId: "u1", sub: { kind: "goodwill" }, amount: E(5n) },
      "store_credit_issue:g1",
      "store_credit_grant",
      "g1",
    ],
    [
      { type: "store_credit_expire", expiryId: "x1", userId: "u1", sub: { kind: "goodwill" }, amount: E(5n) },
      "store_credit_expire:x1",
      "store_credit_expiry",
      "x1",
    ],
    [{ type: "gift_card_sold", cardId: "c1", tender }, "gift_card_sold:c1", "gift_card", "c1"],
    [
      { type: "gift_card_redeemed", cardId: "c1", redemptionId: "d1", userId: "u1", amount: E(5n) },
      "gift_card_redeemed:c1:d1",
      "gift_card",
      "c1",
    ],
    [{ type: "plus_charged", invoiceId: "i1", tender, vatBps: 1_400n }, "plus_charged:i1", "subscription_invoice", "i1"],
    [
      { type: "plus_revenue_recognised", invoiceId: "i1", period: 3, amount: E(5n) },
      "plus_revenue_recognised:i1:3",
      "subscription_invoice",
      "i1",
    ],
  ];

  it.each(cases.map((c) => [c[0].type, ...c] as const))("%s", (_name, cmd, key, refType, refId) => {
    expect(keyOf(cmd)).toEqual({ key, ref: { type: refType, id: refId } });
  });

  it("stamps the derived key, reference and kind onto the built entry", () => {
    const kinds: Record<string, string> = {
      order_paid: "order_recognised",
      order_cod_confirmed: "order_recognised",
      cod_collected: "clearing_settled",
      bnpl_settled: "clearing_settled",
      psp_settled: "clearing_settled",
      refund: "refund_issued",
      seller_payout: "seller_payout",
      seller_promo_netted: "seller_promo_netted",
      store_credit_issue: "store_credit_granted",
      store_credit_expire: "store_credit_expired",
      gift_card_sold: "gift_card_sold",
      gift_card_redeemed: "gift_card_redeemed",
      plus_charged: "plus_charged",
      plus_revenue_recognised: "plus_revenue_recognised",
    };
    for (const [cmd, key, refType, refId] of cases) {
      const cod = cmd.type === "order_cod_confirmed" ? { ...cmd, external: { kind: "cod" as const, courier: "bosta" } } : cmd;
      const e = buildEntry(cod, meta);
      expect(e.idempotencyKey).toBe(key);
      expect(e.ref).toEqual({ type: refType, id: refId });
      expect(e.id).toBe("je_x");
      expect(e.occurredAt).toBe(T0);
      expect(e.kind).toBe(kinds[cmd.type]);
    }
  });
});

describe("settlement parties", () => {
  const mk = (cmd: PostingCommand): JournalEntry => buildEntry(cmd, meta);
  it("clears the right clearing account and books the fee to the right expense", () => {
    const cod = mk({ type: "cod_collected", remittanceId: "r", courier: "bosta", gross: E(1_000n), fee: E(40n), bankAccount: "b" });
    expect(bal(chart.codClearing("bosta"), cod)).toBe(-1_000n);
    expect(bal(chart.courierFeeExpense, cod)).toBe(40n);
    const bnpl = mk({ type: "bnpl_settled", settlementId: "s", provider: "valu", gross: E(1_000n), fee: E(60n), bankAccount: "b" });
    expect(bal(chart.bnplClearing("valu"), bnpl)).toBe(-1_000n);
    expect(bal(chart.providerFeeExpense, bnpl)).toBe(60n);
    const psp = mk({ type: "psp_settled", settlementId: "s", psp: "paymob", gross: E(1_000n), fee: E(25n), bankAccount: "b" });
    expect(bal(chart.pspClearing("paymob"), psp)).toBe(-1_000n);
    expect(bal(chart.providerFeeExpense, psp)).toBe(25n);
    expect(bal(chart.bankSettlement("b"), psp)).toBe(975n);
  });

  it("fails closed when the party identity is missing, and ignores foreign fields", () => {
    const broken = (o: object): PostingCommand =>
      ({ type: "cod_collected", remittanceId: "r", gross: E(10n), fee: E(1n), bankAccount: "b", ...o }) as unknown as PostingCommand;
    expect(() => mk(broken({}))).toThrow(/settlement needs a party/);
    expect(() => mk(broken({ type: "bnpl_settled" }))).toThrow(/settlement needs a party/);
    // A psp settlement that also carries a stray courier is still a psp settlement.
    const stray = mk(broken({ type: "psp_settled", psp: "paymob", courier: "bosta" }));
    expect(bal(chart.pspClearing("paymob"), stray)).toBe(-10n);
    const strayBnpl = mk(broken({ type: "psp_settled", psp: "paymob", provider: "valu" }));
    expect(bal(chart.pspClearing("paymob"), strayBnpl)).toBe(-10n);
  });
});

// ---------------------------------------------------------------------------------------------
// Order planning rules
// ---------------------------------------------------------------------------------------------

describe("order command validation", () => {
  const base: OrderCommandBase = {
    orderGroupId: "og",
    storeOrders: [{ storeId: "A", merchandise: E(10_000n), commissionBps: 1_000n }],
    shippingGross: E(0n),
    vatBps: 1_400n,
    external: { kind: "psp", psp: "p" },
  };
  const paid = (o: Partial<OrderCommandBase>): PostingCommand => ({ type: "order_paid", ...base, ...o });
  const cod = (o: Partial<OrderCommandBase>): PostingCommand => ({ type: "order_cod_confirmed", ...base, ...o });

  it("rejects an empty order and duplicate stores with explicit reasons", () => {
    expect(() => planOrder({ ...base, storeOrders: [] })).toThrow("an order needs a seller order");
    const s = base.storeOrders[0];
    if (s === undefined) throw new Error("fixture");
    expect(() => planOrder({ ...base, storeOrders: [s, s] })).toThrow("a store appears twice");
  });

  it("rejects negative vouchers and out-of-range co-funding, accepting both inclusive bounds", () => {
    expect(() => planOrder({ ...base, platformVoucher: { total: E(-1n) } })).toThrow("voucher must not be negative");
    for (const bps of [-1n, 10_001n]) {
      expect(() => planOrder({ ...base, platformVoucher: { total: E(100n), sellerShareBps: bps } })).toThrow(
        "sellerShareBps out of range",
      );
    }
    const zero = planOrder({ ...base, platformVoucher: { total: E(100n), sellerShareBps: 0n } });
    expect(zero.sellerOrders[0]?.sellerFundedDiscount?.amount).toBe(0n);
    expect(zero.sellerOrders[0]?.platformFundedDiscount?.amount).toBe(100n);
    const full = planOrder({ ...base, platformVoucher: { total: E(100n), sellerShareBps: 10_000n } });
    expect(full.sellerOrders[0]?.sellerFundedDiscount?.amount).toBe(100n);
    expect(full.sellerOrders[0]?.platformFundedDiscount?.amount).toBe(0n);
  });

  it("does not post when store credit leaves a balance unpaid and no external tender exists", () => {
    const credit = { userId: "u", spend: [{ sub: { kind: "goodwill" as const }, amount: E(9_999n) }] };
    expect(() => buildEntry(paid({ external: null, storeCredit: credit }), meta)).toThrow(
      "store credit leaves 1 piastres unpaid",
    );
  });

  it("keeps cash on delivery and prepaid flows apart", () => {
    const full = { userId: "u", spend: [{ sub: { kind: "goodwill" as const }, amount: E(10_000n) }] };
    expect(() => buildEntry(cod({ external: null, storeCredit: full }), meta)).toThrow(
      "a cash on delivery order needs a courier",
    );
    expect(() => buildEntry(paid({ external: { kind: "cod", courier: "bosta" } }), meta)).toThrow(
      "cash on delivery orders are posted by order_cod_confirmed",
    );
    expect(() => buildEntry(cod({ external: { kind: "psp", psp: "p" } }), meta)).toThrow(
      "order_cod_confirmed needs a cod external tender",
    );
    expect(() => buildEntry(cod({ external: { kind: "bnpl", provider: "valu" } }), meta)).toThrow(
      "order_cod_confirmed needs a cod external tender",
    );
    expect(() => buildEntry(paid({ storeCredit: full }), meta)).toThrow(
      "store credit already covers the order; remove the external tender",
    );
    // A cod order is accepted with a cod tender, and a prepaid order with bnpl.
    expect(() => buildEntry(cod({ external: { kind: "cod", courier: "bosta" } }), meta)).not.toThrow();
    expect(() => buildEntry(paid({ external: { kind: "bnpl", provider: "valu" } }), meta)).not.toThrow();
  });

  it("an order fully paid by store credit posts exactly the credit spend", () => {
    const full = { userId: "u", spend: [{ sub: { kind: "goodwill" as const }, amount: E(10_000n) }] };
    const e = buildEntry(paid({ external: null, storeCredit: full }), meta);
    expect(bal(chart.storeCredit("u", { kind: "goodwill" }), e)).toBe(-10_000n);
  });
});

describe("error messages", () => {
  it("names the key and the entry that conflicted", () => {
    const e = new PostingConflictError("k1", "je_7");
    expect(e.message).toBe('idempotency key "k1" was already used for a different entry (je_7)');
    expect(e.idempotencyKey).toBe("k1");
    expect(e.existingEntryId).toBe("je_7");
  });
});

// ---------------------------------------------------------------------------------------------
// Refund planning
// ---------------------------------------------------------------------------------------------

describe("voucherRelease", () => {
  const line = (id: string, g: bigint, before = 0n) => ({ lineId: id, gross: E(g), refundedBefore: E(before) });

  it("rejects a negative voucher from either funder", () => {
    const l = [line("a", 100n)];
    const i = [{ lineId: "a", goods: E(1n) }];
    expect(() => voucherRelease(E(-1n), E(0n), l, i)).toThrow("voucher must not be negative");
    expect(() => voucherRelease(E(0n), E(-1n), l, i)).toThrow("voucher must not be negative");
  });

  it("allows vouchers up to the merchandise value and no further", () => {
    const l = [line("a", 20n)];
    const i = [{ lineId: "a", goods: E(20n) }];
    expect(voucherRelease(E(10n), E(10n), l, i)).toEqual({ platform: E(10n), seller: E(10n) });
    expect(() => voucherRelease(E(15n), E(10n), l, i)).toThrow("vouchers exceed the merchandise value of the order");
  });

  it("splits a refund of one line between funders in the order's funding ratio", () => {
    const l = [line("a", 10_000n), line("b", 30_000n)];
    expect(voucherRelease(E(4_000n), E(6_000n), l, [{ lineId: "a", goods: E(10_000n) }])).toEqual({
      platform: E(1_000n),
      seller: E(1_500n),
    });
    expect(voucherRelease(E(0n), E(6_000n), l, [{ lineId: "b", goods: E(30_000n) }])).toEqual({
      platform: E(0n),
      seller: E(4_500n),
    });
  });

  it("rejects an unknown line", () => {
    expect(() => voucherRelease(E(0n), E(0n), [line("a", 10n)], [{ lineId: "zz", goods: E(1n) }])).toThrow(
      "unknown line zz",
    );
  });

  it("property: no line is ever refunded more voucher than goods; the whole order releases the vouchers exactly", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 5_000n }), { minLength: 1, maxLength: 5 }),
        fc.nat({ max: 100 }),
        fc.nat({ max: 100 }),
        (grosses, pPct, sPct) => {
          const merch = grosses.reduce((a, g) => a + g, 0n);
          const platform = (merch * BigInt(Math.min(pPct, 100))) / 200n;
          const seller = (merch * BigInt(Math.min(sPct, 100))) / 200n;
          const lines = grosses.map((g, i) => line(`l${i}`, g));
          let p = 0n;
          let s = 0n;
          for (const l of lines) {
            const r = voucherRelease(E(platform), E(seller), lines, [{ lineId: l.lineId, goods: l.gross }]);
            expect(r.platform.amount + r.seller.amount).toBeLessThanOrEqual(l.gross.amount);
            p += r.platform.amount;
            s += r.seller.amount;
          }
          expect(p).toBe(platform);
          expect(s).toBe(seller);
        },
      ),
    );
  });

  it("small tied lines never carry more discount than their value", () => {
    const l = [line("a", 1n), line("b", 1n), line("c", 1n)];
    for (const id of ["a", "b", "c"]) {
      const r = voucherRelease(E(1n), E(1n), l, [{ lineId: id, goods: E(1n) }]);
      expect(r.platform.amount + r.seller.amount).toBeLessThanOrEqual(1n);
    }
  });
});

describe("planRefund rules", () => {
  const psp = (amount: bigint, refunded = 0n, name = "paymob") => ({
    tender: { kind: "psp" as const, psp: name, amount: E(amount) },
    refunded: E(refunded),
  });
  const base: RefundPlanInput = {
    userId: "u1",
    storeId: "A",
    commissionBps: 1_000n,
    vatBps: 1_400n,
    lines: [
      { lineId: "l1", gross: E(10_000n), refundedBefore: E(0n) },
      { lineId: "l2", gross: E(20_000n), refundedBefore: E(0n) },
    ],
    items: [{ lineId: "l1", goods: E(10_000n) }],
    platformVoucher: E(0n),
    sellerVoucher: E(0n),
    tenders: [psp(30_000n)],
    choice: "original",
  };

  it("validates line state and amounts with explicit reasons", () => {
    const withLine = (gross: bigint, before: bigint) => ({
      ...base,
      lines: [{ lineId: "l1", gross: E(gross), refundedBefore: E(before) }],
      items: [{ lineId: "l1", goods: E(1n) }],
    });
    expect(() => planRefund(withLine(10n, -1n))).toThrow("line state is invalid");
    expect(() => planRefund(withLine(0n, 0n))).toThrow("line state is invalid");
    expect(() => planRefund(withLine(-5n, 0n))).toThrow("line state is invalid");
    expect(() => planRefund(withLine(10n, 10n))).toThrow(RefundExceedsOriginalError);
    expect(() => planRefund(withLine(10n, 10n))).toThrow("line l1 would be refunded above its value");
    expect(() => planRefund({ ...base, items: [] })).toThrow("a refund needs at least one item");
    expect(() => planRefund({ ...base, items: [{ lineId: "l1", goods: E(0n) }] })).toThrow("refunded goods must be positive");
    expect(() => planRefund({ ...base, items: [{ lineId: "l1", goods: E(-1n) }] })).toThrow("refunded goods must be positive");
    expect(() =>
      planRefund({ ...base, items: [{ lineId: "l1", goods: E(1n) }, { lineId: "l1", goods: E(1n) }] }),
    ).toThrow("line l1 listed twice");
    expect(() => planRefund({ ...base, items: [{ lineId: "nope", goods: E(1n) }] })).toThrow("unknown line nope");
    // Exactly the remaining value is fine.
    expect(planRefund(withLine(10n, 9n)).total.amount).toBe(1n);
  });

  it("refuses when a tender was already refunded above its amount, even if others have room", () => {
    const overRefunded = { tender: { kind: "psp" as const, psp: "x", amount: E(100n) }, refunded: E(200n) };
    expect(() => planRefund({ ...base, tenders: [overRefunded, psp(30_000n)] })).toThrow(RefundExceedsOriginalError);
    expect(() => planRefund({ ...base, tenders: [overRefunded, psp(30_000n)] })).toThrow(
      "a tender is refunded above its amount",
    );
  });

  it("states the amount and remaining capacity when the refund is too large, and allows exact capacity", () => {
    expect(() => planRefund({ ...base, tenders: [psp(30_000n, 25_000n)] })).toThrow(
      "refund 10000 exceeds the 5000 still refundable",
    );
    expect(planRefund({ ...base, tenders: [psp(10_000n)] }).total.amount).toBe(10_000n);
  });

  it("a voucher that covers the goods completely moves no money but still unwinds the seller side", () => {
    const plan = planRefund({ ...base, lines: [{ lineId: "l1", gross: E(10_000n), refundedBefore: E(0n) }], platformVoucher: E(10_000n) });
    expect(plan.total.amount).toBe(0n);
    expect(plan.input.destinations).toEqual([]);
    expect(plan.drawn).toEqual([]);
    expect(plan.routedToCredit).toBe(false);
    expect(plan.platformShare.amount).toBe(10_000n);
  });

  it("skips fully refunded tenders and draws only from the remaining ones", () => {
    const plan = planRefund({ ...base, tenders: [psp(20_000n, 20_000n, "old"), psp(30_000n, 0n, "new")] });
    expect(plan.drawn).toEqual([{ index: 1, amount: E(10_000n) }]);
    expect(plan.input.destinations).toEqual([{ kind: "psp", psp: "new", amount: E(10_000n) }]);
  });

  it("draws pro rata by remaining refundable amount (partial refund after refund)", () => {
    const plan = planRefund({ ...base, tenders: [psp(20_000n, 10_000n, "a"), psp(20_000n, 0n, "b")] });
    // remaining 10,000 and 20,000 -> 10,000 splits 3,333 / 6,667 (largest remainder).
    expect(plan.drawn.map((d) => d.amount.amount)).toEqual([3_333n, 6_667n]);
    expect(plan.drawn.reduce((a, d) => a + d.amount.amount, 0n)).toBe(plan.total.amount);
  });

  it("merges destinations that land on the same account and keeps different kinds apart", () => {
    const credit = (sub: "goodwill" | "cashback_coins", amount: bigint) => ({
      tender: { kind: "store_credit" as const, userId: "u1", sub: { kind: sub }, amount: E(amount) },
      refunded: E(0n),
    });
    const sameName = planRefund({
      ...base,
      tenders: [
        psp(10_000n, 0n, "x"),
        { tender: { kind: "cod", courier: "x", amount: E(10_000n) }, refunded: E(0n) },
        { tender: { kind: "bnpl", provider: "x", amount: E(10_000n) }, refunded: E(0n) },
      ],
    });
    expect(sameName.input.destinations.map((d) => d.kind)).toEqual(["psp", "cod", "bnpl"]);
    expect(sameName.input.destinations.map((d) => d.amount.amount)).toEqual([3_334n, 3_333n, 3_333n]);

    const twoPsps = planRefund({ ...base, tenders: [psp(10_000n, 0n, "a"), psp(10_000n, 0n, "b")] });
    expect(twoPsps.input.destinations).toHaveLength(2);

    const merged = planRefund({ ...base, tenders: [psp(10_000n, 0n, "a"), psp(10_000n, 0n, "a")] });
    expect(merged.input.destinations).toEqual([{ kind: "psp", psp: "a", amount: E(10_000n) }]);

    const subs = planRefund({ ...base, tenders: [credit("goodwill", 10_000n), credit("cashback_coins", 10_000n)] });
    expect(subs.input.destinations).toHaveLength(2);

    const sameSub = planRefund({ ...base, tenders: [credit("goodwill", 5_000n), credit("goodwill", 5_000n)] });
    expect(sameSub.input.destinations).toEqual([
      { kind: "store_credit", userId: "u1", sub: { kind: "goodwill" }, amount: E(10_000n) },
    ]);

    // Two tenders both re-routed to credit collapse into one refund_credit destination.
    const rerouted = planRefund({ ...base, choice: "store_credit", tenders: [psp(10_000n, 0n, "a"), psp(10_000n, 0n, "b")] });
    expect(rerouted.input.destinations).toEqual([
      { kind: "store_credit", userId: "u1", sub: { kind: "refund_credit" }, amount: E(10_000n) },
    ]);
    expect(rerouted.routedToCredit).toBe(true);
  });

  it("reports routing to credit only when something was actually re-routed", () => {
    const bnpl = planRefund({ ...base, choice: "store_credit", tenders: [{ tender: { kind: "bnpl", provider: "valu", amount: E(30_000n) }, refunded: E(0n) }] });
    expect(bnpl.routedToCredit).toBe(false);
    const orig = planRefund({ ...base, tenders: [{ tender: { kind: "cod", courier: "b", amount: E(30_000n) }, refunded: E(0n) }] });
    expect(orig.routedToCredit).toBe(false);
    const collectedChoice = planRefund({
      ...base,
      choice: "store_credit",
      tenders: [{ tender: { kind: "cod", courier: "b", amount: E(30_000n) }, refunded: E(0n), collected: false }],
    });
    expect(collectedChoice.routedToCredit).toBe(true);
    const back = planRefund({
      ...base,
      tenders: [{ tender: { kind: "store_credit", userId: "other", sub: { kind: "gift_card", cardId: "c1" }, amount: E(30_000n) }, refunded: E(0n) }],
    });
    // Back to the exact sub-balance and owner it came from, even for another user id.
    expect(back.input.destinations).toEqual([
      { kind: "store_credit", userId: "other", sub: { kind: "gift_card", cardId: "c1" }, amount: E(10_000n) },
    ]);
    expect(back.routedToCredit).toBe(false);
  });

  it("only carries shipping when there is some to refund", () => {
    expect(planRefund(base).input).not.toHaveProperty("shippingGross");
    expect(planRefund({ ...base, shippingGross: E(0n) }).input).not.toHaveProperty("shippingGross");
    expect(planRefund({ ...base, shippingGross: E(1n) }).input.shippingGross?.amount).toBe(1n);
  });

  it("records cumulative refunded goods so commission differences telescope", () => {
    const lines = [{ lineId: "l1", gross: E(10_000n), refundedBefore: E(4_000n) }, { lineId: "l2", gross: E(20_000n), refundedBefore: E(1_000n) }];
    const plan = planRefund({ ...base, lines, items: [{ lineId: "l1", goods: E(2_000n) }], tenders: [psp(30_000n, 5_000n)] });
    expect(plan.input.goodsRefunded.amount).toBe(2_000n);
    expect(plan.input.goodsRefundedBefore.amount).toBe(5_000n);
  });
});

// ---------------------------------------------------------------------------------------------
// Fingerprint, reversal, hash chain
// ---------------------------------------------------------------------------------------------

function entry(i: number, over: { kind?: string; refType?: string; reversed?: boolean } = {}): JournalEntry {
  const postings = [
    { account: chart.pspClearing("p"), amount: E(1_000n) },
    { account: chart.sellerPayable("A"), amount: E(-1_000n) },
  ];
  return createJournalEntry({
    id: `e${i}`,
    kind: over.kind ?? "test",
    idempotencyKey: `k${i}`,
    occurredAt: new Date(1_700_000_000_000 + i),
    ref: { type: over.refType ?? "t", id: String(i) },
    postings: over.reversed === true ? [...postings].reverse() : postings,
  });
}

describe("canonical forms", () => {
  it("fingerprint is the versioned, sorted canonical tuple", () => {
    expect(canonicalPayload(entry(1))).toBe(
      JSON.stringify(["v1", "test", "t", "1", ["psp_clearing:p|1000|EGP", "seller_payable:A|-1000|EGP"]]),
    );
  });

  it("chain payload carries id, key, time, reference, reversal target and sorted postings", () => {
    const e = entry(2);
    expect(chainPayload(e)).toBe(
      JSON.stringify(["v1", "e2", "test", "k2", 1_700_000_000_002, "t", "2", null, ["psp_clearing:p|1000|EGP", "seller_payable:A|-1000|EGP"]]),
    );
    expect(chainPayload(entry(2, { reversed: true }))).toBe(chainPayload(e));
    const rev = entry(3, { kind: "reversal", refType: "journal_entry" });
    expect(JSON.parse(chainPayload(rev))[7]).toBe("3");
  });

  it("genesis is 64 zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    expect(GENESIS_HASH).toHaveLength(64);
  });
});

describe("reversesOf", () => {
  it("is set only when the entry is a reversal AND references a journal entry", () => {
    expect(reversesOf(entry(1, { kind: "reversal", refType: "journal_entry" }))).toBe("1");
    expect(reversesOf(entry(1, { kind: "reversal", refType: "order_group" }))).toBeNull();
    expect(reversesOf(entry(1, { kind: "other", refType: "journal_entry" }))).toBeNull();
    expect(reversalKey("e1")).toBe("reversal:e1");
  });
});

describe("hash chain ordering", () => {
  const build = (seqs: bigint[]): ChainedEntry[] => {
    let prev = GENESIS_HASH;
    return seqs.map((seq, i) => {
      const e = entry(i);
      const h = nextHash(prev, e, sha);
      const link = { seq, entryId: e.id, prevHash: prev, entryHash: h };
      prev = h;
      return { entry: e, link };
    });
  };

  it("accepts any starting sequence, including 0 and negatives, but never a repeated or lower one", () => {
    expect(verifyChain(build([0n, 1n]), sha).ok).toBe(true);
    expect(verifyChain(build([-5n, -4n]), sha).ok).toBe(true);
    const dup = verifyChain(build([1n, 1n]), sha);
    expect(dup).toMatchObject({ ok: false, reason: "sequence_not_increasing", seq: 1n, entryId: "e1" });
    expect(verifyChain(build([5n, 3n]), sha)).toMatchObject({ ok: false, reason: "sequence_not_increasing" });
  });
});

// ---------------------------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------------------------

describe("store credit integrity", () => {
  const acct = (u: string, s: string) => `store_credit:${u}:${s}` as ReturnType<typeof chart.storeCredit>;

  it("ignores accounts that are not store credit, even ones outside the chart", () => {
    const r = storeCreditDrift([], [
      { account: "totally_unknown" as never, currency: "EGP", raw: -5n },
      { account: chart.sellerPayable("A"), currency: "EGP", raw: -5n },
    ]);
    expect(r).toEqual({ drift: [], negative: [] });
  });

  it("reports a projection with no postings, and postings with no projection", () => {
    const r = storeCreditDrift(
      [{ userId: "u1", sub: "goodwill", balance: 70n }],
      [{ account: acct("u2", "referral_credit"), currency: "EGP", raw: -30n }],
    );
    expect(r.drift).toEqual([
      { userId: "u1", sub: "goodwill", projected: 70n, fromPostings: 0n, difference: 70n },
      { userId: "u2", sub: "referral_credit", projected: 0n, fromPostings: 30n, difference: -30n },
    ]);
    expect(r.negative).toEqual([]);
  });

  it("flags negative balances on their own, and drift on its own, in the overall verdict", () => {
    const totals = new Map<string, bigint>([["EGP", 0n]]);
    const common = { totals, chained: [] as ChainedEntry[], sha256: sha };
    const negativeOnly = buildIntegrityReport({
      ...common,
      projection: [{ userId: "u", sub: "goodwill", balance: -10n }],
      accountBalances: [{ account: acct("u", "goodwill"), currency: "EGP", raw: 10n }],
    });
    expect(negativeOnly.storeCredit.drift).toEqual([]);
    expect(negativeOnly.storeCredit.negative).toHaveLength(1);
    expect(negativeOnly.ok).toBe(false);
    const driftOnly = buildIntegrityReport({
      ...common,
      projection: [{ userId: "u", sub: "goodwill", balance: 10n }],
      accountBalances: [{ account: acct("u", "goodwill"), currency: "EGP", raw: -20n }],
    });
    expect(driftOnly.storeCredit.negative).toEqual([]);
    expect(driftOnly.ok).toBe(false);
    const clean = buildIntegrityReport({
      ...common,
      projection: [{ userId: "u", sub: "goodwill", balance: 10n }],
      accountBalances: [{ account: acct("u", "goodwill"), currency: "EGP", raw: -10n }],
    });
    expect(clean.ok).toBe(true);
  });
});
