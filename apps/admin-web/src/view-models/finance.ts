import type { LedgerBalanceWire, ReconBreakWire } from "../api/schemas";
import { parseMinor } from "../lib/format";

export interface TrialBalanceLine {
  readonly currency: string;
  readonly sumMinor: bigint;
  readonly accounts: number;
}

export interface TrialBalance {
  readonly lines: readonly TrialBalanceLine[];
  /** All currencies sum to zero over the rows we have. */
  readonly balanced: boolean;
  /** The page may be truncated: a balanced result is then NOT a proof, and the UI must say so. */
  readonly complete: boolean;
  readonly unparseable: number;
}

/** Double-entry check: signed postings (`raw`, debit positive) sum to zero per currency over ALL accounts. */
export function trialBalance(items: readonly LedgerBalanceWire[], requestedLimit: number): TrialBalance {
  const sums = new Map<string, { sum: bigint; accounts: number }>();
  let bad = 0;
  for (const i of items) {
    const v = parseMinor(i.raw);
    if (v === null) {
      bad += 1;
      continue;
    }
    const cur = sums.get(i.currency) ?? { sum: 0n, accounts: 0 };
    sums.set(i.currency, { sum: cur.sum + v, accounts: cur.accounts + 1 });
  }
  const lines = [...sums.entries()].map(([currency, v]) => ({ currency, sumMinor: v.sum, accounts: v.accounts })).sort((a, b) => a.currency.localeCompare(b.currency));
  return {
    lines,
    balanced: bad === 0 && lines.every((l) => l.sumMinor === 0n),
    complete: items.length < requestedLimit,
    unparseable: bad,
  };
}

/** Aging above 3 days goes to Finance escalation (spec T4). */
export const ESCALATION_AGE_MS = 3 * 86_400_000;

export interface BreakRow {
  readonly id: string;
  readonly kind: ReconBreakWire["kind"];
  readonly status: ReconBreakWire["status"];
  readonly reference: string | null;
  readonly expectedMinor: bigint | null;
  readonly actualMinor: bigint | null;
  /** actual - expected, when both are known. */
  readonly differenceMinor: bigint | null;
  readonly ageMs: number;
  readonly escalate: boolean;
  readonly open: boolean;
}

export function breakRows(items: readonly ReconBreakWire[], serverNowMs: number): readonly BreakRow[] {
  return items
    .map((b): BreakRow => {
      const exp = b.expected === undefined ? null : parseMinor(b.expected.amount);
      const act = b.actual === undefined ? null : parseMinor(b.actual.amount);
      const age = Math.max(0, serverNowMs - Date.parse(b.detected_at));
      const delta = b.amount_delta === undefined ? null : parseMinor(b.amount_delta.amount);
      const open = b.status !== "resolved";
      return {
        id: b.id,
        kind: b.kind,
        status: b.status,
        reference: b.reference ?? null,
        expectedMinor: exp,
        actualMinor: act,
        differenceMinor: exp !== null && act !== null ? act - exp : delta,
        ageMs: age,
        escalate: open && age > ESCALATION_AGE_MS,
        open,
      };
    })
    .sort((a, b) => Number(b.open) - Number(a.open) || Number(b.escalate) - Number(a.escalate) || b.ageMs - a.ageMs || a.id.localeCompare(b.id));
}
