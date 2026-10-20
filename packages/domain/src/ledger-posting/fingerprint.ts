import type { JournalEntry } from "../ledger";

/**
 * Canonical form of what an entry MEANS: kind, reference and the multiset of postings.
 * The generated id and the timestamp are excluded, so a retry of the same business event
 * (new id, new clock reading) has the same fingerprint, while any change of amount, account,
 * kind or reference changes it. Postings are sorted, so builder order does not matter.
 */
export function canonicalPayload(entry: JournalEntry): string {
  const postings = entry.postings
    .map((p) => `${p.account}|${p.amount.amount.toString()}|${p.amount.currency}`)
    .sort();
  return JSON.stringify(["v1", entry.kind, entry.ref.type, entry.ref.id, postings]);
}

export function samePayload(a: JournalEntry, b: JournalEntry): boolean {
  return canonicalPayload(a) === canonicalPayload(b);
}
