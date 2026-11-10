import { createHash } from "node:crypto";
import { requestHash } from "@outlet/idempotency";

export const GENESIS_HASH = "0".repeat(64);

export interface EntryContent {
  readonly kind: string;
  readonly idempotencyKey: string;
  readonly marketId: string;
  readonly refType: string;
  readonly refId: string;
  readonly reversesEntryId: string | null;
  /** In line order. */
  readonly postings: readonly { readonly accountCode: string; readonly amountMinor: bigint; readonly currency: string }[];
}

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

/**
 * Hash of the business content of an entry (what idempotency compares). occurredAt is deliberately excluded so a
 * retry that re-reads the clock is a replay, not a conflict; it is covered by the chain hash instead.
 */
export const contentHash = (c: EntryContent): string =>
  hex(
    requestHash({
      kind: c.kind,
      idempotencyKey: c.idempotencyKey,
      marketId: c.marketId,
      refType: c.refType,
      refId: c.refId,
      reversesEntryId: c.reversesEntryId,
      postings: c.postings.map((p) => ({ accountCode: p.accountCode, amountMinor: p.amountMinor.toString(), currency: p.currency })),
    }),
  );

export interface ChainLink {
  readonly id: string;
  readonly chainSeq: bigint;
  readonly contentHash: string;
  /** ISO-8601 UTC with milliseconds, e.g. 2026-11-08T10:00:00.123Z. */
  readonly occurredAt: string;
  readonly prevHash: string;
}

export const chainHash = (l: ChainLink): string =>
  createHash("sha256").update(`${l.prevHash}|${l.chainSeq.toString()}|${l.id}|${l.contentHash}|${l.occurredAt}`).digest("hex");
