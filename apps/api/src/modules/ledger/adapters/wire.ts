import type { BalanceRow, StoredEntry } from "../domain/ports";

/** Wire shapes are explicit allow-lists (API3). bigint travels as a decimal string. */
export const balanceWire = (b: BalanceRow) => ({
  account: b.account,
  type: b.type,
  owner_type: b.ownerType,
  owner_id: b.ownerId,
  sub_key: b.subKey,
  currency: b.currency,
  /** Signed sum of postings: positive is a debit. */
  raw: b.raw.toString(),
  /** Positive means the account holds what its type normally holds. */
  balance: b.natural.toString(),
  posting_count: b.postingCount,
});

export const entryWire = (s: StoredEntry) => ({
  id: s.entry.id,
  kind: s.entry.kind,
  idempotency_key: s.entry.idempotencyKey,
  occurred_at: s.entry.occurredAt.toISOString(),
  ref: { type: s.entry.ref.type, id: s.entry.ref.id },
  postings: s.entry.postings.map((p) => ({
    account: p.account,
    amount: p.amount.amount.toString(),
    currency: p.amount.currency,
  })),
  chain: { seq: s.link.seq.toString(), prev_hash: s.link.prevHash, entry_hash: s.link.entryHash },
});
