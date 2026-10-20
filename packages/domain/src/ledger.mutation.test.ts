import { describe, expect, it } from "vitest";
import { InvalidEntryError, UnbalancedEntryError } from "./errors";
import {
  accounts,
  balanceOf,
  createJournalEntry,
  reverseEntry,
  sumByCurrency,
  trialBalance,
  type JournalEntry,
  type NewJournalEntry,
  type Posting,
} from "./ledger";
import { money, type Money } from "./money";

const at = new Date("2026-10-10T12:00:00Z");
const usd = (amount: bigint): Money => ({ amount, currency: "USD" }) as unknown as Money;
const p = (account: string, amount: bigint): Posting => ({ account, amount: money(amount) });

function input(postings: Posting[], overrides: Partial<NewJournalEntry> = {}): NewJournalEntry {
  return {
    id: "e1",
    kind: "order_paid",
    idempotencyKey: "key-1",
    occurredAt: at,
    ref: { type: "order_group", id: "og1" },
    postings,
    ...overrides,
  };
}

describe("account id helpers", () => {
  it("builds ids in the spec T4 format", () => {
    expect(accounts.pspClearing("kashier")).toBe("psp_clearing:kashier");
    expect(accounts.codClearing("bosta")).toBe("cod_clearing:bosta");
    expect(accounts.bnplClearing("valu")).toBe("bnpl_clearing:valu");
    expect(accounts.sellerPayable("s1")).toBe("seller_payable:s1");
    expect(accounts.storeCredit("u1", "gift_card")).toBe("store_credit:u1:gift_card");
    expect(accounts.platformCommission).toBe("platform_commission");
    expect(accounts.platformVatOutput).toBe("platform_vat_output");
    expect(accounts.shippingRevenue).toBe("shipping_revenue");
    expect(accounts.giftCardLiability).toBe("gift_card_liability");
    expect(accounts.refundReserve).toBe("refund_reserve");
  });
});

describe("sumByCurrency", () => {
  it("adds signed amounts per currency", () => {
    const totals = sumByCurrency([p("a", 5n), p("b", -3n), p("c", 10n)]);
    expect(totals.get("EGP")).toBe(12n);
    expect(totals.size).toBe(1);
  });

  it("keeps currencies separate", () => {
    const totals = sumByCurrency([p("a", 5n), { account: "b", amount: usd(-5n) }]);
    expect(totals.get("EGP")).toBe(5n);
    expect((totals as Map<string, bigint>).get("USD")).toBe(-5n);
  });

  it("is empty for no postings", () => {
    expect(sumByCurrency([]).size).toBe(0);
  });
});

describe("createJournalEntry validation messages", () => {
  it("requires an idempotency key (blank and whitespace)", () => {
    for (const key of ["", "   ", "\t\n"]) {
      const run = (): JournalEntry => createJournalEntry(input([p("a", 1n), p("b", -1n)], { idempotencyKey: key }));
      expect(run).toThrow(InvalidEntryError);
      expect(run).toThrow("idempotencyKey is required");
    }
  });

  it("requires at least two postings, reported before balance checks", () => {
    expect(() => createJournalEntry(input([]))).toThrow("an entry needs at least two postings");
    expect(() => createJournalEntry(input([p("a", 5n)]))).toThrow(InvalidEntryError);
    expect(() => createJournalEntry(input([p("a", 5n)]))).toThrow("an entry needs at least two postings");
  });

  it("accepts exactly two postings", () => {
    expect(createJournalEntry(input([p("a", 5n), p("b", -5n)])).postings).toHaveLength(2);
  });

  it("rejects blank and whitespace-only accounts", () => {
    for (const account of ["", "  ", "\t"]) {
      const run = (): JournalEntry => createJournalEntry(input([p(account, 5n), p("b", -5n)]));
      expect(run).toThrow(InvalidEntryError);
      expect(run).toThrow("posting has no account");
    }
    // a padded but non-empty account is allowed
    expect(() => createJournalEntry(input([p(" a ", 5n), p("b", -5n)]))).not.toThrow();
  });

  it("rejects zero-amount postings with the documented message", () => {
    const run = (): JournalEntry => createJournalEntry(input([p("a", 5n), p("b", -5n), p("c", 0n)]));
    expect(run).toThrow(InvalidEntryError);
    expect(run).toThrow("zero-amount postings are not allowed");
  });

  it("reports the currency and the imbalance in the message", () => {
    expect(() => createJournalEntry(input([p("a", 100n), p("b", -99n)]))).toThrow(
      "entry does not balance in EGP: off by 1",
    );
    expect(() => createJournalEntry(input([p("a", 100n), p("b", -101n)]))).toThrow(
      "entry does not balance in EGP: off by -1",
    );
    expect(() => createJournalEntry(input([p("a", 100n), p("b", -101n)]))).toThrow(UnbalancedEntryError);
  });

  it("balances each currency independently", () => {
    const ok = createJournalEntry(
      input([p("a", 5n), p("b", -5n), { account: "c", amount: usd(7n) }, { account: "d", amount: usd(-7n) }]),
    );
    expect(ok.postings).toHaveLength(4);
  });
});

describe("createJournalEntry output", () => {
  it("returns a copy: same fields, new posting objects", () => {
    const postings = [p("a", 5n), p("b", -5n)];
    const e = createJournalEntry(input(postings));
    expect(e.id).toBe("e1");
    expect(e.kind).toBe("order_paid");
    expect(e.idempotencyKey).toBe("key-1");
    expect(e.occurredAt).toBe(at);
    expect(e.ref).toEqual({ type: "order_group", id: "og1" });
    expect(e.postings).toEqual(postings);
    expect(e.postings[0]).not.toBe(postings[0]);
  });
});

describe("reverseEntry", () => {
  const original = createJournalEntry(input([p("a", 300n), p("b", -100n), p("c", -200n)]));

  it("produces a balanced reversal entry with the supplied metadata", () => {
    const later = new Date("2026-10-11T00:00:00Z");
    const r = reverseEntry(original, { id: "r1", idempotencyKey: "rev-key", occurredAt: later });
    expect(r.kind).toBe("reversal");
    expect(r.id).toBe("r1");
    expect(r.idempotencyKey).toBe("rev-key");
    expect(r.occurredAt).toBe(later);
    expect(r.ref).toEqual({ type: "journal_entry", id: "e1" });
    expect(r.postings.map((x) => [x.account, x.amount.amount])).toEqual([
      ["a", -300n],
      ["b", 100n],
      ["c", 200n],
    ]);
  });

  it("validates the reversal's own idempotency key", () => {
    expect(() => reverseEntry(original, { id: "r1", idempotencyKey: " ", occurredAt: at })).toThrow(
      "idempotencyKey is required",
    );
  });
});

describe("balanceOf and trialBalance", () => {
  const e1 = createJournalEntry(input([p("a", 100n), p("b", -100n)]));
  const e2 = createJournalEntry(input([p("a", 40n), p("c", -40n)], { id: "e2", idempotencyKey: "k2" }));
  const eUsd = createJournalEntry(
    input([{ account: "a", amount: usd(9n) }, { account: "b", amount: usd(-9n) }], {
      id: "e3",
      idempotencyKey: "k3",
    }),
  );

  it("sums only the requested account", () => {
    expect(balanceOf("a", [e1, e2]).amount).toBe(140n);
    expect(balanceOf("b", [e1, e2]).amount).toBe(-100n);
    expect(balanceOf("c", [e1, e2]).amount).toBe(-40n);
    expect(balanceOf("missing", [e1, e2]).amount).toBe(0n);
    expect(balanceOf("a", []).amount).toBe(0n);
  });

  it("filters by currency and reports it", () => {
    expect(balanceOf("a", [e1, eUsd]).amount).toBe(100n);
    expect(balanceOf("a", [e1, eUsd]).currency).toBe("EGP");
    const asUsd = balanceOf("a", [e1, eUsd], "USD" as unknown as "EGP");
    expect(asUsd.amount).toBe(9n);
    expect(asUsd.currency).toBe("USD");
  });

  it("trial balance nets to zero per currency and is empty without entries", () => {
    const tb = trialBalance([e1, e2, eUsd]) as Map<string, bigint>;
    expect(tb.get("EGP")).toBe(0n);
    expect(tb.get("USD")).toBe(0n);
    expect(trialBalance([]).size).toBe(0);
  });
});
