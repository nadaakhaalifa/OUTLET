import { chart, storeCreditGranted, type EntryMeta, type StoreCreditSub } from "../chart-of-accounts";
import { createJournalEntry, type JournalEntry } from "../ledger";
import { money } from "../money";
import { InvalidCoinInputError } from "./errors";

export type CoinSub = Extract<StoreCreditSub, { kind: "cashback_coins" } | { kind: "referral_credit" }>;

/** Platform funded grant: Dr promo_expense_platform, Cr store_credit:{user}:{sub}. Balanced by construction. */
export function coinGrantEntry(input: { readonly userId: string; readonly sub: CoinSub; readonly piastres: bigint }, meta: EntryMeta): JournalEntry {
  if (input.piastres <= 0n) throw new InvalidCoinInputError("grant must be positive");
  return storeCreditGranted({ userId: input.userId, sub: input.sub, amount: money(input.piastres) }, meta);
}

/**
 * Reversing entry for a clawback: Dr store_credit, Cr promo_expense_platform. The amount may be
 * smaller than the original grant (proportional refund); it is a new balanced entry, never an edit.
 */
export function coinClawbackEntry(input: { readonly userId: string; readonly sub: CoinSub; readonly piastres: bigint }, meta: EntryMeta): JournalEntry {
  if (input.piastres <= 0n) throw new InvalidCoinInputError("clawback must be positive");
  return createJournalEntry({
    id: meta.id,
    kind: "coins_clawed_back",
    idempotencyKey: meta.idempotencyKey,
    occurredAt: meta.occurredAt,
    ref: meta.ref,
    postings: [
      { account: chart.storeCredit(input.userId, input.sub), amount: money(input.piastres) },
      { account: chart.promoExpensePlatform, amount: money(-input.piastres) },
    ],
  });
}
