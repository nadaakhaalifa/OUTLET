import { reverseEntry, type JournalEntry } from "../ledger";
import { InvalidReversalError } from "./errors";

export const REVERSAL_KIND = "reversal";

/** One reversal per entry, so the key is derived from the original and repeating is a replay. */
export const reversalKey = (originalId: string): string => `reversal:${originalId}`;

/** The entry a reversal undoes, or null for an ordinary entry. */
export function reversesOf(entry: JournalEntry): string | null {
  return entry.kind === REVERSAL_KIND && entry.ref.type === "journal_entry" ? entry.ref.id : null;
}

export function buildReversal(
  original: JournalEntry,
  meta: { readonly id: string; readonly occurredAt: Date },
): JournalEntry {
  if (reversesOf(original) !== null) {
    throw new InvalidReversalError("a reversal cannot itself be reversed; post a new entry instead");
  }
  return reverseEntry(original, { id: meta.id, idempotencyKey: reversalKey(original.id), occurredAt: meta.occurredAt });
}
