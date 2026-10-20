import { InvalidReconciliationInputError } from "./errors";
import type { ReconLine } from "./types";

export interface MatchedPair {
  readonly key: string;
  readonly externalId: string;
  readonly internalId: string;
  readonly amount: bigint;
}

export interface MismatchedPair {
  readonly key: string;
  readonly externalId: string;
  readonly internalId: string;
  readonly external: bigint;
  readonly internal: bigint;
  readonly atMs: number;
}

export interface MatchTotals {
  readonly external: bigint;
  readonly internal: bigint;
  readonly matched: bigint;
  readonly mismatchedExternal: bigint;
  readonly mismatchedInternal: bigint;
  readonly unmatchedExternal: bigint;
  readonly unmatchedInternal: bigint;
  readonly duplicateExternal: bigint;
  readonly duplicateInternal: bigint;
}

export interface MatchResult {
  readonly matched: readonly MatchedPair[];
  readonly mismatched: readonly MismatchedPair[];
  readonly unmatchedExternal: readonly ReconLine[];
  readonly unmatchedInternal: readonly ReconLine[];
  readonly duplicateExternal: readonly ReconLine[];
  readonly duplicateInternal: readonly ReconLine[];
  readonly totals: MatchTotals;
}

const cmp = <T extends string | bigint | number>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (a: ReconLine, b: ReconLine): number =>
  cmp(a.key, b.key) || cmp(a.amount, b.amount) || cmp(a.id, b.id);

function requireUnique(side: string, lines: readonly ReconLine[]): void {
  const ids = new Set<string>();
  for (const l of lines) {
    if (ids.has(l.id)) throw new InvalidReconciliationInputError(`duplicate ${side} line id ${l.id}`);
    ids.add(l.id);
  }
}

function groupByKey(lines: readonly ReconLine[]): Map<string, ReconLine[]> {
  const m = new Map<string, ReconLine[]>();
  for (const l of lines) {
    const g = m.get(l.key);
    if (g === undefined) m.set(l.key, [l]);
    else g.push(l);
  }
  return m;
}

const sum = (ls: readonly ReconLine[]): bigint => ls.reduce((a, l) => a + l.amount, 0n);

/**
 * One-to-one matcher. Both sides are sorted into a canonical order first, so the result depends on
 * the multiset of lines, never on arrival order. Within a reference group, equal amounts match
 * first (multiset intersection). Leftovers pair up as amount mismatches. Anything beyond that is
 * a duplicate when the reference already matched exactly, otherwise unmatched. Every line id is
 * consumed at most once and totals are conserved bucket by bucket.
 */
export function matchLines(external: readonly ReconLine[], internal: readonly ReconLine[]): MatchResult {
  requireUnique("external", external);
  requireUnique("internal", internal);
  const ext = groupByKey([...external].sort(canonical));
  const int = groupByKey([...internal].sort(canonical));
  const keys = [...new Set([...ext.keys(), ...int.keys()])].sort();

  const matched: MatchedPair[] = [];
  const mismatched: MismatchedPair[] = [];
  const unmatchedExternal: ReconLine[] = [];
  const unmatchedInternal: ReconLine[] = [];
  const duplicateExternal: ReconLine[] = [];
  const duplicateInternal: ReconLine[] = [];

  for (const key of keys) {
    const e = ext.get(key) ?? [];
    const i = int.get(key) ?? [];
    const leftE: ReconLine[] = [];
    const leftI: ReconLine[] = [];
    let a = 0;
    let b = 0;
    let exact = 0;
    while (a < e.length && b < i.length) {
      const x = e[a] as ReconLine;
      const y = i[b] as ReconLine;
      if (x.amount === y.amount) {
        matched.push({ key, externalId: x.id, internalId: y.id, amount: x.amount });
        exact += 1;
        a += 1;
        b += 1;
      } else if (x.amount < y.amount) {
        leftE.push(x);
        a += 1;
      } else {
        leftI.push(y);
        b += 1;
      }
    }
    leftE.push(...e.slice(a));
    leftI.push(...i.slice(b));
    const pairs = Math.min(leftE.length, leftI.length);
    for (let p = 0; p < pairs; p += 1) {
      const x = leftE[p] as ReconLine;
      const y = leftI[p] as ReconLine;
      mismatched.push({
        key,
        externalId: x.id,
        internalId: y.id,
        external: x.amount,
        internal: y.amount,
        atMs: Math.min(x.atMs, y.atMs),
      });
    }
    for (const x of leftE.slice(pairs)) (exact > 0 ? duplicateExternal : unmatchedExternal).push(x);
    for (const y of leftI.slice(pairs)) (exact > 0 ? duplicateInternal : unmatchedInternal).push(y);
  }

  const totals: MatchTotals = {
    external: sum(external),
    internal: sum(internal),
    matched: matched.reduce((s, m) => s + m.amount, 0n),
    mismatchedExternal: mismatched.reduce((s, m) => s + m.external, 0n),
    mismatchedInternal: mismatched.reduce((s, m) => s + m.internal, 0n),
    unmatchedExternal: sum(unmatchedExternal),
    unmatchedInternal: sum(unmatchedInternal),
    duplicateExternal: sum(duplicateExternal),
    duplicateInternal: sum(duplicateInternal),
  };
  return { matched, mismatched, unmatchedExternal, unmatchedInternal, duplicateExternal, duplicateInternal, totals };
}

/** True when the buckets add back to the inputs on both sides. Used by tests and the run as a self-check. */
export function conserves(r: MatchResult): boolean {
  const t = r.totals;
  return (
    t.external === t.matched + t.mismatchedExternal + t.unmatchedExternal + t.duplicateExternal &&
    t.internal === t.matched + t.mismatchedInternal + t.unmatchedInternal + t.duplicateInternal
  );
}
