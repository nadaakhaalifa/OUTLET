import { K_MIN, cellKey, type Cell, type Ledger } from "../domain/kanon-table";

/** Exact rational Gaussian elimination (bigint fractions). Rows are published linear forms over the hidden cells. */
type Frac = readonly [bigint, bigint];
const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};
const norm = (n: bigint, d: bigint): Frac => {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return [n / g, d / g];
};
const sub = (a: Frac, b: Frac): Frac => norm(a[0] * b[1] - b[0] * a[1], a[1] * b[1]);
const mul = (a: Frac, b: Frac): Frac => norm(a[0] * b[0], a[1] * b[1]);
const div = (a: Frac, b: Frac): Frac => norm(a[0] * b[1], a[1] * b[0]);

export class RowSpace {
  private readonly basis: { pivot: number; row: Frac[] }[] = [];
  constructor(private readonly n: number) {}
  private reduce(v: Frac[]): Frac[] {
    const r = v.slice();
    for (const b of this.basis) {
      const f = r[b.pivot] as Frac;
      if (f[0] === 0n) continue;
      for (let j = 0; j < this.n; j++) r[j] = sub(r[j] as Frac, mul(f, b.row[j] as Frac));
    }
    return r;
  }
  add(coeffs: readonly number[]): void {
    const r = this.reduce(coeffs.map((c) => norm(BigInt(c), 1n)));
    const pivot = r.findIndex((x) => x[0] !== 0n);
    if (pivot < 0) return;
    const p = r[pivot] as Frac;
    const row = r.map((x) => div(x, p));
    for (const b of this.basis) {
      const f = b.row[pivot] as Frac;
      if (f[0] !== 0n) for (let j = 0; j < this.n; j++) b.row[j] = sub(b.row[j] as Frac, mul(f, row[j] as Frac));
    }
    this.basis.push({ pivot, row });
  }
  contains(indicator: readonly number[]): boolean {
    return this.reduce(indicator.map((c) => norm(BigInt(c), 1n))).every((x) => x[0] === 0n);
  }
}

export interface AuditInput {
  /** Hidden cells: key, column, and the shoppers behind it (all shoppers ever seen). */
  readonly hidden: readonly { readonly key: string; readonly col: string; readonly shoppers: ReadonlySet<string> }[];
  /** Published linear forms over hidden cells, as sets of hidden cell keys (released cells already subtracted). */
  readonly forms: readonly (readonly string[])[];
  /** Hidden cells per column count, to recognise "S is a whole column". */
  readonly columnSizes: ReadonlyMap<string, number>;
}

/** Returns the violating subsets (cell keys). Empty = no linear combination reveals a cell group under K. */
export function audit(input: AuditInput): string[][] {
  const n = input.hidden.length;
  if (n > 16) throw new Error("oracle limited to 16 hidden cells");
  const idx = new Map(input.hidden.map((h, i) => [h.key, i]));
  const space = new RowSpace(n);
  for (const f of input.forms) {
    const v = new Array<number>(n).fill(0);
    for (const k of f) {
      const i = idx.get(k);
      if (i !== undefined) v[i] = 1;
    }
    space.add(v);
  }
  const bad: string[][] = [];
  for (let mask = 1; mask < 1 << n; mask++) {
    const v = new Array<number>(n).fill(0);
    const sel: number[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) {
        v[i] = 1;
        sel.push(i);
      }
    if (!space.contains(v)) continue;
    const union = new Set<string>();
    for (const i of sel) for (const s of (input.hidden[i] as { shoppers: ReadonlySet<string> }).shoppers) union.add(s);
    if (union.size >= K_MIN) continue;
    const perCol = new Map<string, number>();
    for (const i of sel) {
      const c = (input.hidden[i] as { col: string }).col;
      perCol.set(c, (perCol.get(c) ?? 0) + 1);
    }
    // Every touched column fully contained: each sum is a public ungated column total.
    const wholeColumns = [...perCol].every(([c, n]) => n === input.columnSizes.get(c));
    if (!wholeColumns) bad.push(sel.map((i) => (input.hidden[i] as { key: string }).key));
  }
  return bad;
}

/** Audit of a ledger: hidden cells of `cols`, the external margin of every column, every pinned value (no hidden info). */
export function auditLedger(ledger: Ledger, rows: readonly string[], cols: readonly string[], seen: ReadonlyMap<string, ReadonlySet<string>>, extraForms: readonly (readonly string[])[] = []): string[][] {
  const hidden: { key: string; col: string; shoppers: ReadonlySet<string> }[] = [];
  const forms: string[][] = [];
  const columnSizes = new Map<string, number>();
  for (const c of cols) {
    const colHidden: string[] = [];
    for (const r of rows) {
      const k = cellKey(r, c);
      if (ledger.get(k)?.state === "hidden") {
        hidden.push({ key: k, col: c, shoppers: seen.get(k) ?? new Set() });
        colHidden.push(k);
      }
    }
    columnSizes.set(c, rows.length);
    if (colHidden.length > 0) forms.push(colHidden);
  }
  return audit({ hidden, forms: [...forms, ...extraForms], columnSizes });
}

export type { Cell };
