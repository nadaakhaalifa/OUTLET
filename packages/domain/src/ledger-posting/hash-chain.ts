import type { JournalEntry } from "../ledger";
import { reversesOf } from "./reversal";

export const GENESIS_HASH = "0".repeat(64);

/** Injected so the domain stays free of node:crypto. Must return 64 lowercase hex characters. */
export type Sha256Hex = (input: string) => string;

/** Everything that identifies an entry, including its id and time (unlike the idempotency payload). */
export function chainPayload(entry: JournalEntry): string {
  const postings = entry.postings
    .map((p) => `${p.account}|${p.amount.amount.toString()}|${p.amount.currency}`)
    .sort();
  return JSON.stringify([
    "v1",
    entry.id,
    entry.kind,
    entry.idempotencyKey,
    entry.occurredAt.getTime(),
    entry.ref.type,
    entry.ref.id,
    reversesOf(entry),
    postings,
  ]);
}

export function nextHash(prevHash: string, entry: JournalEntry, sha256: Sha256Hex): string {
  return sha256(`${prevHash}\n${chainPayload(entry)}`);
}

export interface ChainLink {
  /** Strictly increasing. Gaps are allowed (rolled back transactions burn identity values). */
  readonly seq: bigint;
  readonly entryId: string;
  readonly prevHash: string;
  readonly entryHash: string;
}

export interface ChainedEntry {
  readonly entry: JournalEntry;
  readonly link: ChainLink;
}

export type ChainFailure =
  | "entry_mismatch"
  | "sequence_not_increasing"
  | "prev_hash_mismatch"
  | "entry_hash_mismatch";

export type ChainVerification =
  | { readonly ok: true; readonly length: number; readonly headHash: string }
  | { readonly ok: false; readonly seq: bigint; readonly entryId: string; readonly reason: ChainFailure };

/** Verifies entries ordered by link.seq. `startHash` allows verifying a suffix from a signed snapshot. */
export function verifyChain(
  items: readonly ChainedEntry[],
  sha256: Sha256Hex,
  startHash: string = GENESIS_HASH,
): ChainVerification {
  let prev = startHash;
  let lastSeq: bigint | null = null;
  for (const { entry, link } of items) {
    const fail = (reason: ChainFailure): ChainVerification => ({ ok: false, seq: link.seq, entryId: entry.id, reason });
    if (link.entryId !== entry.id) return fail("entry_mismatch");
    if (lastSeq !== null && link.seq <= lastSeq) return fail("sequence_not_increasing");
    if (link.prevHash !== prev) return fail("prev_hash_mismatch");
    if (link.entryHash !== nextHash(prev, entry, sha256)) return fail("entry_hash_mismatch");
    prev = link.entryHash;
    lastSeq = link.seq;
  }
  return { ok: true, length: items.length, headHash: prev };
}
