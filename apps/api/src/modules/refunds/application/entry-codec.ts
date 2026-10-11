import { randomUUID } from "node:crypto";
import { createJournalEntry, money, type JournalEntry } from "../domain/bridge";
import type { StoredEntry } from "../domain/ports";

export function toStoredEntry(e: JournalEntry, requires: readonly string[]): StoredEntry {
  return {
    id: e.id,
    requires,
    kind: e.kind,
    idempotencyKey: e.idempotencyKey,
    occurredAtMs: e.occurredAt.getTime(),
    ref: { type: e.ref.type, id: e.ref.id },
    postings: e.postings.map((p) => ({ account: p.account, amount: p.amount.amount })),
  };
}

/**
 * Rebuilds (and re-validates: balance, no zero postings) the entry that intake computed, with the
 * id chosen at intake. Rows written before ids were stored have none: a fresh uuid is safe because
 * the fingerprint of a replay excludes the id and the key is what makes the post idempotent.
 */
export function fromStoredEntry(s: StoredEntry): JournalEntry {
  return createJournalEntry({
    id: s.id === "" ? randomUUID() : s.id,
    kind: s.kind,
    idempotencyKey: s.idempotencyKey,
    occurredAt: new Date(s.occurredAtMs),
    ref: { type: s.ref.type, id: s.ref.id },
    postings: s.postings.map((p) => ({ account: p.account, amount: money(p.amount) })),
  });
}
