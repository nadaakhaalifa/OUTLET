import { createHash } from "node:crypto";
import {
  GENESIS_HASH,
  rowHash,
  verifyChainRows,
  type ChainCheckpoint,
  type ChainRow,
  type Sha256Hex,
} from "../domain/audit-verify";
import type { AttentionReading, AttentionSourcePort, AuditChainReader, ChainVerification } from "../domain/ports";

export const nodeSha256: Sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");

/** In-memory append-only chains for dev and tests. Tamper hooks exist only here. */
export class InMemoryAuditChains implements AuditChainReader {
  private readonly chains = new Map<string, ChainRow[]>();
  private readonly checkpoints = new Map<string, ChainCheckpoint[]>();
  /** Test hook: makes reads reject. */
  failReads = false;

  append(chainId: string, canonical: string): ChainRow {
    const rows = this.chains.get(chainId) ?? [];
    const last = rows[rows.length - 1];
    const prevHash = last?.hash ?? GENESIS_HASH;
    const row: ChainRow = { seq: (last?.seq ?? 0) + 1, prevHash, canonical, hash: rowHash(nodeSha256, prevHash, canonical) };
    this.chains.set(chainId, [...rows, row]);
    return row;
  }
  checkpoint(chainId: string): void {
    const last = this.chains.get(chainId)?.at(-1);
    if (last === undefined) return;
    this.checkpoints.set(chainId, [...(this.checkpoints.get(chainId) ?? []), { lastSeq: last.seq, lastHash: last.hash }]);
  }
  /** Test hooks that simulate a superuser rewriting history. */
  tamperRow(chainId: string, seq: number, canonical: string): void {
    this.chains.set(chainId, (this.chains.get(chainId) ?? []).map((r) => (r.seq === seq ? { ...r, canonical } : r)));
  }
  removeRow(chainId: string, seq: number): void {
    this.chains.set(chainId, (this.chains.get(chainId) ?? []).filter((r) => r.seq !== seq));
  }
  rows(chainId: string): readonly ChainRow[] {
    return this.chains.get(chainId) ?? [];
  }

  async chainLength(chainId: string): Promise<number> {
    if (this.failReads) throw new Error("audit read unavailable");
    return this.rows(chainId).length;
  }
  async verify(chainId: string): Promise<ChainVerification> {
    if (this.failReads) throw new Error("audit read unavailable");
    const rows = this.rows(chainId);
    const cps = this.checkpoints.get(chainId) ?? [];
    const head = rows.at(-1);
    return {
      rowsChecked: rows.length,
      headSeq: head === undefined ? null : String(head.seq),
      headHash: head?.hash ?? null,
      checkpointsChecked: cps.length,
      problems: verifyChainRows(rows, cps, nodeSha256),
    };
  }
}

/** Dev default: fixed readings per item id; missing id => throws (reported unavailable). */
export class InMemoryAttentionSources implements AttentionSourcePort {
  readonly readings = new Map<string, AttentionReading>();
  readonly calls: { itemId: string; actorId: string }[] = [];
  /** Item ids that hang (to prove the 2 s timeout). */
  readonly hang = new Set<string>();
  async read(itemId: string, actorId: string): Promise<AttentionReading> {
    this.calls.push({ itemId, actorId });
    if (this.hang.has(itemId)) return new Promise<AttentionReading>(() => undefined);
    const r = this.readings.get(itemId);
    if (r === undefined) throw new Error("no source");
    return r;
  }
}

/** Production without a configured source: every item is reported unavailable (never 0). */
export class UnconfiguredAttentionSources implements AttentionSourcePort {
  async read(): Promise<AttentionReading> {
    throw new Error("attention source not configured");
  }
}
