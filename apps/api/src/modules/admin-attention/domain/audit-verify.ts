/**
 * Pure hash-chain verification (mirrors audit_log_verify of migration 0005). Used by the in-memory
 * reader and by the property tests; the Postgres reader calls the SQL function instead.
 * hash = sha256(prev_hash || canonical(row)); genesis prev_hash is 32 zero bytes.
 */
export const GENESIS_HASH = "0".repeat(64);
export const MAX_VERIFY_PROBLEMS = 100;
export const MAX_VERIFY_ROWS = 200_000;

export interface ChainRow {
  readonly seq: number;
  readonly prevHash: string;
  readonly hash: string;
  /** Canonical serialisation of every hashed column except seq-independent chain fields. */
  readonly canonical: string;
}
export interface ChainCheckpoint {
  readonly lastSeq: number;
  readonly lastHash: string;
}
export interface ChainProblem {
  readonly seq: number;
  readonly problem: string;
}
export type Sha256Hex = (input: string) => string;

export const rowHash = (sha256: Sha256Hex, prevHash: string, canonical: string): string => sha256(prevHash + canonical);

/** Rows must be ordered by seq ascending. Read-only; returns every problem found (callers truncate). */
export function verifyChainRows(
  rows: readonly ChainRow[],
  checkpoints: readonly ChainCheckpoint[],
  sha256: Sha256Hex,
): ChainProblem[] {
  const problems: ChainProblem[] = [];
  let prev: ChainRow | null = null;
  for (const r of rows) {
    if (prev === null) {
      if (r.seq !== 1) problems.push({ seq: r.seq, problem: "chain does not start at seq 1 (rows removed from the head)" });
      else if (r.prevHash !== GENESIS_HASH) problems.push({ seq: r.seq, problem: "bad genesis prev_hash" });
    } else if (r.seq !== prev.seq + 1) problems.push({ seq: r.seq, problem: "gap in seq (rows removed)" });
    else if (r.prevHash !== prev.hash) problems.push({ seq: r.seq, problem: "prev_hash does not match previous row hash" });
    if (
      (problems[problems.length - 1]?.seq !== r.seq) &&
      r.hash !== rowHash(sha256, r.prevHash, r.canonical)
    ) {
      problems.push({ seq: r.seq, problem: "row content does not match its hash (row modified)" });
    }
    prev = r;
  }
  const bySeq = new Map(rows.map((r) => [r.seq, r]));
  for (const c of checkpoints) {
    const row = bySeq.get(c.lastSeq);
    if (row === undefined) problems.push({ seq: c.lastSeq, problem: "checkpoint refers to a row that no longer exists (tail truncated)" });
    else if (row.hash !== c.lastHash) problems.push({ seq: c.lastSeq, problem: "row hash differs from checkpoint" });
  }
  return problems.sort((a, b) => a.seq - b.seq);
}
