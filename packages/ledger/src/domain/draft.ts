import { CURRENCIES } from "@outlet/money";
import type { Currency, Money } from "@outlet/money";
import { parseAccountCode } from "./account-code.js";
import type { AccountCodeParts } from "./account-code.js";
import { isEntryKind } from "./chart.js";
import type { EntryKind } from "./chart.js";
import { LedgerError } from "./errors.js";

/** Sign convention (P3): positive = debit, negative = credit. */
export interface PostingDraft {
  readonly accountCode: string;
  readonly amount: Money;
}

export interface JournalEntryDraft {
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly marketId: string;
  readonly occurredAt: Date;
  readonly ref: { readonly type: string; readonly id: string };
  readonly postings: readonly PostingDraft[];
  /** Set only by Ledger.reverse. */
  readonly reversesEntryId?: string;
}

export interface ValidatedPosting extends PostingDraft {
  readonly account: AccountCodeParts & { readonly code: string };
}

export interface ValidatedDraft extends Omit<JournalEntryDraft, "kind" | "postings"> {
  readonly kind: EntryKind;
  readonly postings: readonly ValidatedPosting[];
}

const MAX_POSTINGS = 200;
const MAX_KEY = 255;
const BIGINT_MAX = 2n ** 63n - 1n;

/**
 * Pure validation of everything the database also enforces (I1, I2, I3, I19) plus shape rules.
 * Throws LedgerError; returns the draft with parsed account codes.
 */
export function validateDraft(draft: JournalEntryDraft): ValidatedDraft {
  if (!isEntryKind(draft.kind)) throw new LedgerError("LEDGER_INVALID_KIND", `unknown entry kind: ${draft.kind}`);
  if (draft.idempotencyKey.length < 1 || draft.idempotencyKey.length > MAX_KEY) {
    throw new LedgerError("LEDGER_INVALID_DRAFT", "idempotencyKey must be 1 to 255 characters");
  }
  if (draft.marketId.length === 0 || draft.ref.type.length === 0 || draft.ref.id.length === 0) {
    throw new LedgerError("LEDGER_INVALID_DRAFT", "marketId and ref must be non-empty");
  }
  if (Number.isNaN(draft.occurredAt.getTime())) throw new LedgerError("LEDGER_INVALID_DRAFT", "occurredAt is not a valid date");
  if (draft.postings.length < 2) throw new LedgerError("LEDGER_TOO_FEW_POSTINGS", "an entry needs at least two postings");
  if (draft.postings.length > MAX_POSTINGS) throw new LedgerError("LEDGER_INVALID_DRAFT", `an entry has at most ${String(MAX_POSTINGS)} postings`);

  const sums = new Map<Currency, bigint>();
  const postings = draft.postings.map((p): ValidatedPosting => {
    const account = parseAccountCode(p.accountCode);
    if (account.market !== draft.marketId) {
      throw new LedgerError("LEDGER_MARKET_MISMATCH", `account ${account.code} is not in market ${draft.marketId}`);
    }
    if (account.currency !== p.amount.currency) {
      throw new LedgerError("LEDGER_CURRENCY_MISMATCH", `account ${account.code} is ${account.currency}, posting is ${p.amount.currency}`);
    }
    if (typeof p.amount.amountMinor !== "bigint" || !CURRENCIES.includes(p.amount.currency)) {
      throw new LedgerError("LEDGER_INVALID_DRAFT", "posting amount must be bigint Money");
    }
    if (p.amount.amountMinor > BIGINT_MAX || p.amount.amountMinor < -BIGINT_MAX) {
      throw new LedgerError("LEDGER_INVALID_DRAFT", "posting amount is outside the BIGINT range");
    }
    if (p.amount.amountMinor === 0n) throw new LedgerError("LEDGER_ZERO_POSTING", `zero posting on ${account.code}`);
    sums.set(p.amount.currency, (sums.get(p.amount.currency) ?? 0n) + p.amount.amountMinor);
    return { ...p, account };
  });
  for (const [currency, sum] of sums) {
    if (sum !== 0n) throw new LedgerError("LEDGER_UNBALANCED", `entry does not balance in ${currency}`);
  }
  return { ...draft, kind: draft.kind, postings };
}
