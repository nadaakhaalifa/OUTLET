import { InvalidEntryError, UnbalancedEntryError } from "./errors";
import { money, negate, type Currency, type Money } from "./money";

/** Account ids follow the chart in spec §T4, for example `seller_payable:store_123`. */
export type AccountId = string;

export const accounts = {
  pspClearing: (psp: string): AccountId => `psp_clearing:${psp}`,
  codClearing: (courier: string): AccountId => `cod_clearing:${courier}`,
  bnplClearing: (provider: string): AccountId => `bnpl_clearing:${provider}`,
  sellerPayable: (storeId: string): AccountId => `seller_payable:${storeId}`,
  storeCredit: (userId: string, sub: string): AccountId => `store_credit:${userId}:${sub}`,
  platformCommission: "platform_commission",
  platformVatOutput: "platform_vat_output",
  shippingRevenue: "shipping_revenue",
  giftCardLiability: "gift_card_liability",
  refundReserve: "refund_reserve",
} as const;

/** Positive amount is a debit, negative is a credit. */
export interface Posting {
  readonly account: AccountId;
  readonly amount: Money;
}

export interface JournalEntry {
  readonly id: string;
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly occurredAt: Date;
  readonly ref: { readonly type: string; readonly id: string };
  readonly postings: readonly Posting[];
}

export type NewJournalEntry = JournalEntry;

/** Sum of postings per currency. Every value must be 0n for a valid entry. */
export function sumByCurrency(postings: readonly Posting[]): Map<Currency, bigint> {
  const totals = new Map<Currency, bigint>();
  for (const p of postings) {
    totals.set(p.amount.currency, (totals.get(p.amount.currency) ?? 0n) + p.amount.amount);
  }
  return totals;
}

/** Validates and returns the entry. Throws a typed error and never returns a partial result. */
export function createJournalEntry(input: NewJournalEntry): JournalEntry {
  if (input.idempotencyKey.trim().length === 0) {
    throw new InvalidEntryError("idempotencyKey is required");
  }
  if (input.postings.length < 2) {
    throw new InvalidEntryError("an entry needs at least two postings");
  }
  for (const p of input.postings) {
    if (p.account.trim().length === 0) throw new InvalidEntryError("posting has no account");
    if (p.amount.amount === 0n) throw new InvalidEntryError("zero-amount postings are not allowed");
  }
  for (const [currency, total] of sumByCurrency(input.postings)) {
    if (total !== 0n) {
      throw new UnbalancedEntryError(`entry does not balance in ${currency}: off by ${total}`);
    }
  }
  return { ...input, postings: input.postings.map((p) => ({ ...p })) };
}

/** A correction is a new entry that negates every posting of the original. */
export function reverseEntry(
  original: JournalEntry,
  meta: { id: string; idempotencyKey: string; occurredAt: Date },
): JournalEntry {
  return createJournalEntry({
    id: meta.id,
    kind: "reversal",
    idempotencyKey: meta.idempotencyKey,
    occurredAt: meta.occurredAt,
    ref: { type: "journal_entry", id: original.id },
    postings: original.postings.map((p) => ({ account: p.account, amount: negate(p.amount) })),
  });
}

/** Balance of one account in one currency, derived from postings. */
export function balanceOf(
  account: AccountId,
  entries: readonly JournalEntry[],
  currency: Currency = "EGP",
): Money {
  let total = 0n;
  for (const entry of entries) {
    for (const p of entry.postings) {
      if (p.account === account && p.amount.currency === currency) total += p.amount.amount;
    }
  }
  return money(total, currency);
}

/** Global integrity check: across all entries every currency must net to zero. */
export function trialBalance(entries: readonly JournalEntry[]): Map<Currency, bigint> {
  return sumByCurrency(entries.flatMap((e) => e.postings));
}
