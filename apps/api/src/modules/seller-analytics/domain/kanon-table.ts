/**
 * Shopper-gated release (ADR-0052, dashboard foundations track 4, B2). Pure: no I/O, no clock.
 *
 * Breakdowns are ONE-dimensional per column: rows are dimension values, columns are complete Cairo months. No row,
 * multi-month or grand total is ever computed from gated cells. The only sum over a column is the EXTERNAL margin (an
 * ungated metric, see `external-margins.ts`), which is always public. Per column the rule is: the hidden set H is empty,
 * OR its exact union covers >= K distinct shoppers, OR H is the whole column (its sum is the public ungated total).
 *
 * Every aggregate has one immutable ledger entry (`hidden` or `released` with the pinned value). A released aggregate is
 * always served with its pinned value; a recomputed difference is reported as drift, never served.
 * NOT wired to any route, migration or adapter (ADR-0052 is Proposed pending DPO VR-DASH-02/05/06).
 */
export const K_MIN = 50;

export interface Cell {
  /** Additive value (events, orders). */
  readonly value: number;
  readonly shoppers: ReadonlySet<string>;
}

export type LedgerState =
  | { readonly state: "released"; readonly value: number }
  | { readonly state: "hidden"; readonly reason: "primary" | "complementary" };
export type Ledger = ReadonlyMap<string, LedgerState>;
export const EMPTY_LEDGER: Ledger = new Map();

export const cellKey = (row: string, col: string): string => `${row}\u0000${col}`;

export interface BreakdownColumn {
  readonly col: string;
  /** Cells by dimension value (row). A row without an entry has no facts: 0 shoppers. */
  readonly cells: ReadonlyMap<string, Cell>;
}

export interface BreakdownRelease {
  /** null = hidden. Keyed by `cellKey(row, col)`. Released values for pinned cells are the pinned ones. */
  readonly cells: ReadonlyMap<string, number | null>;
  readonly counts: { readonly primary: number; readonly complementary: number; readonly memo: number; readonly pinned: number };
  /** Keys whose recomputed value differs from the pinned one (the pinned one is served). */
  readonly drift: readonly string[];
  /** Columns still unsafe after every not-yet-pinned cell was hidden: nothing new is released there. */
  readonly residualColumns: readonly string[];
  readonly wholeSeries: boolean;
  /** To insert (insert-only) into the ledger before the response leaves. Never contains an existing key. */
  readonly ledgerInserts: ReadonlyMap<string, LedgerState>;
}

export class LedgerConflict extends Error {
  constructor(readonly key: string) {
    super(`release ledger conflict at ${JSON.stringify(key)}`);
    this.name = "LedgerConflict";
  }
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function unionSize(cells: readonly (Cell | undefined)[]): number {
  const u = new Set<string>();
  for (const c of cells) if (c !== undefined) for (const s of c.shoppers) u.add(s);
  return u.size;
}

/** Thrown when a column holds a cell outside `rows`, or `rows` has duplicates: rows must be the whole fixed domain. */
export class RowDomainViolation extends Error {
  constructor(readonly detail: string) {
    super(`row domain violation: ${detail}`);
    this.name = "RowDomainViolation";
  }
}

/**
 * `rows` MUST be the registry's fixed dimension domain (`dimensionDomain(metric)`), never a filtered or top-N subset:
 * "H is the whole column" is only equivalent to the public ungated total when rows span the whole domain.
 */
export function releaseBreakdown(columns: readonly BreakdownColumn[], rows: readonly string[], ledger: Ledger = EMPTY_LEDGER): BreakdownRelease {
  const domain = new Set(rows);
  if (domain.size !== rows.length) throw new RowDomainViolation("duplicate rows");
  for (const column of columns) for (const r of column.cells.keys()) if (!domain.has(r)) throw new RowDomainViolation(`cell row ${JSON.stringify(r)} not in rows (column ${column.col})`);
  const out = new Map<string, number | null>();
  const inserts = new Map<string, LedgerState>();
  const drift: string[] = [];
  const residualColumns: string[] = [];
  const counts = { primary: 0, complementary: 0, memo: 0, pinned: 0 };
  let total = 0;
  let released = 0;

  for (const column of columns) {
    type Kind = "pinned" | "memo" | "primary" | "complementary" | "tentative";
    const kind = new Map<string, Kind>();
    for (const r of rows) {
      const key = cellKey(r, column.col);
      const led = ledger.get(key);
      const cell = column.cells.get(r);
      if (led?.state === "released") {
        kind.set(r, "pinned");
        if ((cell?.value ?? 0) !== led.value) drift.push(key);
      } else if (led?.state === "hidden") kind.set(r, "memo");
      else kind.set(r, (cell?.shoppers.size ?? 0) < K_MIN ? "primary" : "tentative");
    }
    const hiddenRows = (): string[] => rows.filter((r) => {
      const k = kind.get(r);
      return k === "memo" || k === "primary" || k === "complementary";
    });
    for (let guard = 0; guard <= rows.length; guard++) {
      const h = hiddenRows();
      if (h.length === 0 || h.length === rows.length || unionSize(h.map((r) => column.cells.get(r))) >= K_MIN) break;
      const candidates = rows.filter((r) => kind.get(r) === "tentative");
      if (candidates.length === 0) {
        residualColumns.push(column.col);
        break;
      }
      candidates.sort((a, b) => (column.cells.get(a)?.shoppers.size ?? 0) - (column.cells.get(b)?.shoppers.size ?? 0) || cmp(a, b));
      kind.set(candidates[0] as string, "complementary");
    }
    for (const r of rows) {
      const key = cellKey(r, column.col);
      const k = kind.get(r) as Kind;
      const value = column.cells.get(r)?.value ?? 0;
      total += 1;
      if (k === "pinned") {
        out.set(key, (ledger.get(key) as { value: number }).value);
        counts.pinned += 1;
        released += 1;
      } else if (k === "memo") {
        out.set(key, null);
        counts.memo += 1;
      } else if (k === "tentative") {
        out.set(key, value);
        inserts.set(key, { state: "released", value });
        released += 1;
      } else {
        out.set(key, null);
        counts[k] += 1;
        inserts.set(key, { state: "hidden", reason: k });
      }
    }
  }
  return { cells: out, counts, drift, residualColumns, wholeSeries: total > 0 && released === 0, ledgerInserts: inserts };
}

export interface DistinctPoint {
  /** Ledger key: a Cairo day or month bucket. */
  readonly bucket: string;
  /** The exact value of this point (a distinct count or a rate). */
  readonly value: number;
  /** Exact distinct shoppers (purchasers for a rate) behind the point. */
  readonly shoppers: number;
}
export interface DistinctRelease {
  readonly points: ReadonlyMap<string, number | null>;
  readonly counts: { readonly primary: number; readonly memo: number; readonly pinned: number };
  readonly drift: readonly string[];
  readonly ledgerInserts: ReadonlyMap<string, LedgerState>;
}

/** Non-additive gated series: primary suppression only (each point is its own exact count), same pinned ledger. */
export function releaseDistinctSeries(points: readonly DistinctPoint[], ledger: Ledger = EMPTY_LEDGER): DistinctRelease {
  const out = new Map<string, number | null>();
  const inserts = new Map<string, LedgerState>();
  const drift: string[] = [];
  const counts = { primary: 0, memo: 0, pinned: 0 };
  for (const p of points) {
    const led = ledger.get(p.bucket);
    if (led?.state === "released") {
      out.set(p.bucket, led.value);
      counts.pinned += 1;
      if (led.value !== p.value) drift.push(p.bucket);
    } else if (led?.state === "hidden") {
      out.set(p.bucket, null);
      counts.memo += 1;
    } else if (p.shoppers < K_MIN) {
      out.set(p.bucket, null);
      counts.primary += 1;
      inserts.set(p.bucket, { state: "hidden", reason: "primary" });
    } else {
      out.set(p.bucket, p.value);
      inserts.set(p.bucket, { state: "released", value: p.value });
    }
  }
  return { points: out, counts, drift, ledgerInserts: inserts };
}

/**
 * Insert-only ledger update. An insert whose state differs from an existing one throws `LedgerConflict` (fail closed:
 * the caller answers 503). hidden vs hidden is not a conflict (the reason of the first insert is kept).
 */
export function applyLedger(ledger: Ledger, inserts: ReadonlyMap<string, LedgerState>): Ledger {
  const next = new Map(ledger);
  for (const [key, s] of inserts) {
    const cur = next.get(key);
    if (cur === undefined) next.set(key, s);
    else if (cur.state !== s.state || (cur.state === "released" && s.state === "released" && cur.value !== s.value)) throw new LedgerConflict(key);
  }
  return next;
}

/**
 * Top `limit` rows by the sum of their RELEASED cells (hidden count as nothing), plus one `other_released` value per
 * column that sums ONLY released cells of the remaining rows (those cells are pinned like any other).
 */
export function topRows(r: BreakdownRelease, rows: readonly string[], cols: readonly string[], limit = 10): { readonly top: readonly string[]; readonly otherReleased: ReadonlyMap<string, number> } {
  const sum = (row: string): number => cols.reduce((s, c) => s + (r.cells.get(cellKey(row, c)) ?? 0), 0);
  const ranked = [...rows].sort((a, b) => sum(b) - sum(a) || cmp(a, b));
  const top = ranked.slice(0, limit);
  const rest = ranked.slice(limit);
  const other = new Map<string, number>();
  for (const c of cols) other.set(c, rest.reduce((s, row) => s + (r.cells.get(cellKey(row, c)) ?? 0), 0));
  return { top, otherReleased: other };
}
