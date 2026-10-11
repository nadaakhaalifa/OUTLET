import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { InvalidEntryError, UnbalancedEntryError } from "./errors";
import {
  accounts,
  balanceOf,
  createJournalEntry,
  reverseEntry,
  trialBalance,
  type JournalEntry,
  type Posting,
} from "./ledger";
import { allocate, money, percentOfBps } from "./money";

const at = new Date("2026-10-10T12:00:00Z");

function entry(postings: Posting[], key = "k1", id = "e1"): JournalEntry {
  return createJournalEntry({
    id,
    kind: "test",
    idempotencyKey: key,
    occurredAt: at,
    ref: { type: "order_group", id: "og1" },
    postings,
  });
}

const p = (account: string, amount: bigint): Posting => ({ account, amount: money(amount) });

describe("createJournalEntry", () => {
  it("accepts a balanced entry", () => {
    expect(() => entry([p("a", 100n), p("b", -100n)])).not.toThrow();
  });

  it("rejects an unbalanced entry", () => {
    expect(() => entry([p("a", 100n), p("b", -99n)])).toThrow(UnbalancedEntryError);
  });

  it("rejects fewer than two postings, zero amounts and a missing key", () => {
    expect(() => entry([p("a", 0n)])).toThrow(InvalidEntryError);
    expect(() => entry([p("a", 0n), p("b", 0n)])).toThrow(InvalidEntryError);
    expect(() => entry([p("a", 1n), p("b", -1n)], "  ")).toThrow(InvalidEntryError);
  });

  it("requires each currency to balance on its own", () => {
    const usd = (account: string, amount: bigint): Posting => ({
      account,
      amount: { amount, currency: "USD" } as unknown as Posting["amount"],
    });
    // EGP nets to zero overall only if USD is used to offset it, which must fail.
    expect(() => entry([p("a", 100n), usd("b", -100n)])).toThrow(UnbalancedEntryError);
  });

  it("accepts any random set of postings that sums to zero", () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 1n, max: 1_000_000n }), { minLength: 1, maxLength: 8 }),
        (credits) => {
          const total = credits.reduce((s, c) => s + c, 0n);
          const postings = [
            p("debit", total),
            ...credits.map((c, i) => p(`credit:${i}`, -c)),
          ];
          expect(() => entry(postings)).not.toThrow();
        },
      ),
    );
  });
});

describe("worked example: order paid (spec §T4)", () => {
  // Basket 2,500.00 EGP across two sellers plus commission, VAT on commission and shipping.
  const commission = money(23_000n); // 230.00 EGP
  const vatOnCommission = percentOfBps(commission, 1_400n); // 14% -> 32.20 EGP

  const paid = entry([
    { account: accounts.pspClearing("kashier"), amount: money(250_000n) },
    { account: accounts.sellerPayable("A"), amount: money(-160_000n) },
    { account: accounts.sellerPayable("B"), amount: money(-60_000n) },
    { account: accounts.platformCommission, amount: money(-commission.amount) },
    { account: accounts.platformVatOutput, amount: money(-vatOnCommission.amount) },
    { account: accounts.shippingRevenue, amount: money(-3_780n) },
  ]);

  it("computes VAT on commission exactly and balances to zero", () => {
    expect(vatOnCommission.amount).toBe(3_220n);
    expect(trialBalance([paid]).get("EGP")).toBe(0n);
  });

  it("derives balances from postings", () => {
    expect(balanceOf(accounts.pspClearing("kashier"), [paid]).amount).toBe(250_000n);
    expect(balanceOf(accounts.sellerPayable("A"), [paid]).amount).toBe(-160_000n);
  });

  it("is fully undone by its reversal, per account and in total", () => {
    const reversal = reverseEntry(paid, { id: "e2", idempotencyKey: "rev-1", occurredAt: at });
    expect(reversal.ref).toEqual({ type: "journal_entry", id: "e1" });
    for (const posting of paid.postings) {
      expect(balanceOf(posting.account, [paid, reversal]).amount).toBe(0n);
    }
    expect(trialBalance([paid, reversal]).get("EGP")).toBe(0n);
  });
});

describe("allocating a basket across sellers keeps the ledger balanced", () => {
  it("balances for arbitrary totals and seller weights", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        fc.array(fc.bigInt({ min: 1n, max: 500n }), { minLength: 1, maxLength: 6 }),
        (total, weights) => {
          const shares = allocate(money(total), weights);
          const postings: Posting[] = [
            { account: accounts.pspClearing("kashier"), amount: money(total) },
            ...shares.map((s, i) => ({
              account: accounts.sellerPayable(`s${i}`),
              amount: money(-s.amount),
            })),
          ].filter((x) => x.amount.amount !== 0n);
          expect(() => entry(postings)).not.toThrow();
        },
      ),
    );
  });
});
