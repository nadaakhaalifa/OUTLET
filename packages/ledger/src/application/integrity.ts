import { createHash } from "node:crypto";
import type { Queryable } from "@outlet/db";
import { verifyChain } from "./ledger.js";
import type { ChainVerification } from "./ledger.js";

export interface CurrencyTotal {
  readonly currency: string;
  /** Sum of every posting of the market in this currency. Must be 0 (double entry). */
  readonly totalMinor: bigint;
}
export interface UnbalancedEntry {
  readonly entryId: string;
  readonly currency: string;
  readonly deltaMinor: bigint;
}
export interface IntegrityScan {
  readonly totals: readonly CurrencyTotal[];
  readonly unbalanced: readonly UnbalancedEntry[];
  readonly chain: ChainVerification;
  /** True when every currency totals 0 and no entry is unbalanced. */
  readonly balanced: boolean;
  /** sha256 over (market, day, per-currency totals, chain head); see snapshotDigest. */
  readonly snapshotSha256: string;
}

/** Cap on unbalanced entries listed in one scan (a broken ledger must not make one run unbounded). The count is still exact via `unbalancedTotal`. */
export const MAX_UNBALANCED_LISTED = 200;

/**
 * Canonical, order-independent digest of a day's ledger state: `market|day|CUR=total;CUR=total|head`, currencies sorted. `head` is the last entry hash
 * of a verified chain, or `broken:<entryId>` so a broken chain never produces the digest of a healthy one.
 */
export const snapshotDigest = (marketId: string, day: string, totals: readonly CurrencyTotal[], chain: ChainVerification): string => {
  const t = [...totals].sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0)).map((x) => `${x.currency}=${x.totalMinor.toString()}`).join(";");
  const head = chain.ok ? chain.headHash : `broken:${chain.entryId}`;
  return createHash("sha256").update(`${marketId}|${day}|${t}|${head}`).digest("hex");
};

/**
 * Read-only integrity scan of one market (master prompt T4): per-currency trial balance, per-entry balance, and the hash chain recomputed from stored rows
 * (verifyChain, I20; or the caller's own incremental `chainResult`, see IntegrityJob). Pure reads: the caller (payouts IntegrityJob, job finance.reconcile) persists the outcome. Never run on a request path (full scan).
 */
export async function integrityScan(tx: Queryable, marketId: string, day: string, chainResult?: ChainVerification): Promise<IntegrityScan & { readonly unbalancedTotal: number }> {
  const totalsR = await tx.query<{ currency: string; total: string }>(
    "SELECT currency, SUM(amount_minor)::text AS total FROM postings WHERE market_id = $1 GROUP BY currency ORDER BY currency",
    [marketId],
  );
  const totals = totalsR.rows.map((r) => ({ currency: r.currency, totalMinor: BigInt(r.total) }));
  const badR = await tx.query<{ entry_id: string; currency: string; delta: string }>(
    "SELECT entry_id, currency, SUM(amount_minor)::text AS delta FROM postings WHERE market_id = $1 GROUP BY entry_id, currency HAVING SUM(amount_minor) <> 0 ORDER BY entry_id, currency LIMIT $2",
    [marketId, MAX_UNBALANCED_LISTED],
  );
  const badCount = await tx.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM (SELECT 1 FROM postings WHERE market_id = $1 GROUP BY entry_id, currency HAVING SUM(amount_minor) <> 0) x",
    [marketId],
  );
  const unbalanced = badR.rows.map((r) => ({ entryId: r.entry_id, currency: r.currency, deltaMinor: BigInt(r.delta) }));
  const unbalancedTotal = Number(badCount.rows[0]?.n ?? "0");
  const chain = chainResult ?? (await verifyChain(tx, marketId));
  return {
    totals, unbalanced, unbalancedTotal, chain,
    balanced: unbalancedTotal === 0 && totals.every((t) => t.totalMinor === 0n),
    snapshotSha256: snapshotDigest(marketId, day, totals, chain),
  };
}
