import { describeAccount } from "../chart-of-accounts";
import type { AccountId, JournalEntry } from "../ledger";
import { trialBalance } from "../ledger";
import { verifyChain, type ChainedEntry, type ChainVerification, type Sha256Hex } from "./hash-chain";

export interface StoredBalance {
  readonly account: AccountId;
  readonly currency: string;
  /** Raw signed sum of postings: positive debit, negative credit. */
  readonly raw: bigint;
}

export interface TrialBalanceReport {
  readonly ok: boolean;
  /** Only currencies that do not net to zero. */
  readonly offenders: readonly { readonly currency: string; readonly total: bigint }[];
}

/** Global check (T4): per currency, all postings sum to zero. */
export function checkTrialBalance(totals: ReadonlyMap<string, bigint>): TrialBalanceReport {
  const offenders = [...totals].filter(([, total]) => total !== 0n).map(([currency, total]) => ({ currency, total }));
  return { ok: offenders.length === 0, offenders };
}

export function trialBalanceOfEntries(entries: readonly JournalEntry[]): TrialBalanceReport {
  return checkTrialBalance(trialBalance(entries));
}

export interface ProjectionRow {
  readonly userId: string;
  readonly sub: string;
  /** Cached wallet projection, natural sign (positive = HAUL credit owed to the shopper). */
  readonly balance: bigint;
}

export interface DriftRow {
  readonly userId: string;
  readonly sub: string;
  readonly projected: bigint;
  readonly fromPostings: bigint;
  readonly difference: bigint;
}

/**
 * Compares the cached projection with balances derived from postings (15.2). A sub-balance that
 * exists on only one side counts as 0 on the other. Also reports negative store credit, which the
 * chart forbids ("never negative").
 */
export function storeCreditDrift(
  projection: readonly ProjectionRow[],
  accountBalances: readonly StoredBalance[],
): { readonly drift: readonly DriftRow[]; readonly negative: readonly DriftRow[] } {
  const key = (u: string, s: string): string => JSON.stringify([u, s]);
  const posted = new Map<string, { userId: string; sub: string; value: bigint }>();
  for (const b of accountBalances) {
    if (!b.account.startsWith("store_credit:")) continue;
    const { definition, parameters } = describeAccount(b.account);
    if (definition.type !== "store_credit") continue;
    const [userId = "", sub = ""] = parameters;
    posted.set(key(userId, sub), { userId, sub, value: -b.raw });
  }
  const projected = new Map(projection.map((p) => [key(p.userId, p.sub), p] as const));
  const keys = new Set([...posted.keys(), ...projected.keys()]);
  const drift: DriftRow[] = [];
  const negative: DriftRow[] = [];
  for (const k of [...keys].sort()) {
    const post = posted.get(k);
    const proj = projected.get(k);
    const row: DriftRow = {
      userId: post?.userId ?? proj?.userId ?? "",
      sub: post?.sub ?? proj?.sub ?? "",
      projected: proj?.balance ?? 0n,
      fromPostings: post?.value ?? 0n,
      difference: (proj?.balance ?? 0n) - (post?.value ?? 0n),
    };
    if (row.difference !== 0n) drift.push(row);
    if (row.fromPostings < 0n) negative.push(row);
  }
  return { drift, negative };
}

export interface IntegrityReport {
  readonly ok: boolean;
  readonly trialBalance: TrialBalanceReport;
  readonly chain: ChainVerification;
  readonly storeCredit: { readonly drift: readonly DriftRow[]; readonly negative: readonly DriftRow[] };
}

export function buildIntegrityReport(input: {
  readonly totals: ReadonlyMap<string, bigint>;
  readonly chained: readonly ChainedEntry[];
  readonly sha256: Sha256Hex;
  readonly projection: readonly ProjectionRow[];
  readonly accountBalances: readonly StoredBalance[];
}): IntegrityReport {
  const trial = checkTrialBalance(input.totals);
  const chain = verifyChain(input.chained, input.sha256);
  const storeCredit = storeCreditDrift(input.projection, input.accountBalances);
  return {
    ok: trial.ok && chain.ok && storeCredit.drift.length === 0 && storeCredit.negative.length === 0,
    trialBalance: trial,
    chain,
    storeCredit,
  };
}

