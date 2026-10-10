import { createHmac } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { FIT_PREFERENCES, type BrandHistory, type ChartError, type ChartRow, type FitRating, type ItemCounts } from "../domain/bridge";
import type {
  DemandRepository,
  FeedbackRecord,
  FeedbackRepository,
  Page,
  ProfileKind,
  ProfileRecord,
  SizeChartRepository,
  SizeProfileRepository,
  StoredChart,
} from "../domain/ports";

/** Raw SQL only (same approach as the inventory adapter): tables are owned by migration 0017. */
export type SizingDb = Kysely<Record<string, never>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One transaction under the `system` role (same convention as KyselyInventoryStore; ADR-0020). */
async function inTx<T>(db: SizingDb, run: (trx: SizingDb) => Promise<T>): Promise<T> {
  return db.transaction().execute(async (trx) => {
    await sql`select set_config('app.role', 'system', true)`.execute(trx);
    return run(trx as unknown as SizingDb);
  });
}

/** Keyset cursor: (createdAtMs, id) of the last item served. It never references a live row. */
const encodeCursor = (createdAtMs: number, seq: number, id: string, scope: string): string =>
  Buffer.from(`${String(createdAtMs)}|${String(seq)}|${id}|${scope}`, "utf8").toString("base64url");
function decodeCursor(cursor: string | null, scope: string): { ms: number; seq: number; id: string } | null | "invalid" {
  if (cursor === null) return null;
  const s = Buffer.from(cursor, "base64url").toString("utf8");
  const m = /^(\d{1,15})\|(\d{1,9})\|([0-9a-f-]{36})\|([0-9a-f-]{36})$/.exec(s);
  if (m === null || !UUID.test(m[3] ?? "") || m[4] !== scope) return "invalid";
  return { ms: Number(m[1]), seq: Number(m[2]), id: m[3] ?? "" };
}

const bytes = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return new Uint8Array(v);
  throw new TypeError("expected bytea");
};
const toBuf = (v: Uint8Array): Buffer => Buffer.from(v);
const ms = (n: unknown): number => Math.round(Number(n));
const ts = (m: number): string => new Date(m).toISOString();

const KIND_TO_DB: Readonly<Record<ProfileKind, string>> = { me: "ME", partner: "PARTNER", child: "CHILD" };
const KIND_FROM_DB: Readonly<Record<string, ProfileKind>> = { ME: "me", PARTNER: "partner", CHILD: "child" };

const ProfileRow = z.object({
  id: z.string(),
  user_id: z.string(),
  kind: z.enum(["ME", "PARTNER", "CHILD"]),
  label: z.custom<Uint8Array>((v) => v instanceof Uint8Array),
  measurements: z.custom<Uint8Array>((v) => v instanceof Uint8Array).nullable(),
  quick_start: z.custom<Uint8Array>((v) => v instanceof Uint8Array).nullable(),
  fit_pref: z.enum(["SNUG", "REGULAR", "LOOSE"]),
  modest_fit: z.boolean(),
  version: z.number().int(),
  created_ms: z.coerce.number(),
  updated_ms: z.coerce.number(),
});

const PROFILE_COLS = sql`id::text as id, user_id::text as user_id, kind, label, measurements, quick_start, fit_pref, modest_fit,
  version, extract(epoch from created_at) * 1000 as created_ms, extract(epoch from updated_at) * 1000 as updated_ms`;

function toProfile(raw: unknown): ProfileRecord {
  const r = ProfileRow.parse(raw);
  const pref = FIT_PREFERENCES.find((p) => p.toUpperCase() === r.fit_pref);
  const kind = KIND_FROM_DB[r.kind];
  if (pref === undefined || kind === undefined) throw new TypeError("unmapped enum from size_profiles");
  return {
    id: r.id,
    userId: r.user_id,
    kind,
    labelEnc: bytes(r.label),
    measurementsEnc: r.measurements === null ? null : bytes(r.measurements),
    quickStartEnc: r.quick_start === null ? null : bytes(r.quick_start),
    fitPreference: pref,
    modestFit: r.modest_fit,
    version: r.version,
    createdAtMs: ms(r.created_ms),
    updatedAtMs: ms(r.updated_ms),
  };
}

export class KyselySizeProfileRepository implements SizeProfileRepository {
  constructor(private readonly db: SizingDb) {}

  async countLive(userId: string): Promise<number> {
    return inTx(this.db, async (trx) => {
      const r = await sql<{ n: number }>`select count(*)::int as n from size_profiles where user_id = ${userId}::uuid and deleted_at is null`.execute(trx);
      return r.rows[0]?.n ?? 0;
    });
  }

  async insert(record: ProfileRecord): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`
        insert into size_profiles (id, user_id, kind, label, measurements, quick_start, fit_pref, modest_fit, version, created_at, updated_at)
        values (${record.id}::uuid, ${record.userId}::uuid, ${KIND_TO_DB[record.kind]}, ${toBuf(record.labelEnc)},
                ${record.measurementsEnc === null ? null : toBuf(record.measurementsEnc)},
                ${record.quickStartEnc === null ? null : toBuf(record.quickStartEnc)},
                ${record.fitPreference.toUpperCase()}, ${record.modestFit}, ${record.version},
                ${ts(record.createdAtMs)}::timestamptz, ${ts(record.updatedAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async get(userId: string, id: string): Promise<ProfileRecord | null> {
    if (!UUID.test(id)) return null;
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`select ${PROFILE_COLS} from size_profiles
        where id = ${id}::uuid and user_id = ${userId}::uuid and deleted_at is null`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toProfile(row);
    });
  }

  async list(userId: string, page: { cursor: string | null; limit: number }): Promise<Page<ProfileRecord> | "invalid_cursor"> {
    const after = decodeCursor(page.cursor, userId);
    if (after === "invalid") return "invalid_cursor";
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`select ${PROFILE_COLS} from size_profiles
        where user_id = ${userId}::uuid and deleted_at is null
          and (${after === null ? null : ts(after.ms)}::timestamptz is null
               or (created_at, id) > (${after === null ? null : ts(after.ms)}::timestamptz, ${after?.id ?? null}::uuid))
        order by created_at, id limit ${page.limit + 1}`.execute(trx);
      const all = r.rows.map(toProfile);
      const items = all.slice(0, page.limit);
      const last = items[items.length - 1];
      return { items, nextCursor: all.length > page.limit && last !== undefined ? encodeCursor(last.createdAtMs, 0, last.id, userId) : null };
    });
  }

  async update(record: ProfileRecord, expectedVersion: number): Promise<"updated" | "conflict" | "not_found"> {
    return inTx(this.db, async (trx) => {
      const r = await sql<{ id: string }>`
        update size_profiles set
          kind = ${KIND_TO_DB[record.kind]}, label = ${toBuf(record.labelEnc)},
          measurements = ${record.measurementsEnc === null ? null : toBuf(record.measurementsEnc)},
          quick_start = ${record.quickStartEnc === null ? null : toBuf(record.quickStartEnc)},
          fit_pref = ${record.fitPreference.toUpperCase()}, modest_fit = ${record.modestFit}, version = ${record.version}
        where id = ${record.id}::uuid and user_id = ${record.userId}::uuid and deleted_at is null and version = ${expectedVersion}
        returning id::text as id`.execute(trx);
      if (r.rows.length > 0) return "updated" as const;
      const exists = await sql<{ n: number }>`select count(*)::int as n from size_profiles
        where id = ${record.id}::uuid and user_id = ${record.userId}::uuid and deleted_at is null`.execute(trx);
      return (exists.rows[0]?.n ?? 0) > 0 ? ("conflict" as const) : ("not_found" as const);
    });
  }

  /** Soft delete that also erases the P3 ciphertext (right to erasure, spec 2): the row keeps only its id. */
  async delete(userId: string, id: string): Promise<boolean> {
    if (!UUID.test(id)) return false;
    return inTx(this.db, async (trx) => {
      const r = await sql<{ id: string }>`
        update size_profiles set deleted_at = now(), label = ''::bytea, measurements = null, quick_start = null
        where id = ${id}::uuid and user_id = ${userId}::uuid and deleted_at is null
        returning id::text as id`.execute(trx);
      return r.rows.length > 0;
    });
  }
}

const RowsSchema = z.array(z.object({ sizeLabel: z.string(), measurements: z.record(z.string(), z.number()) }));
const ErrorsSchema = z.array(z.object({ sizeLabel: z.string(), code: z.string() }));
const ChartRowSchema = z.object({
  id: z.string(),
  store_id: z.string(),
  product_type: z.string(),
  chart_version: z.number().int(),
  unit_entered: z.enum(["cm", "in"]),
  rows: z.unknown(),
  validated: z.boolean(),
  validation_errors: z.unknown(),
  created_ms: z.coerce.number(),
});
const CHART_COLS = sql`id::text as id, store_id::text as store_id, product_type, chart_version, unit_entered, rows, validated,
  validation_errors, extract(epoch from created_at) * 1000 as created_ms`;

const parseJson = (v: unknown): unknown => (typeof v === "string" ? (JSON.parse(v) as unknown) : v);

function toChart(raw: unknown): StoredChart {
  const r = ChartRowSchema.parse(raw);
  // Rows are persisted by this adapter; the schema narrows the jsonb back to the domain shape.
  const rows = RowsSchema.parse(parseJson(r.rows)) as unknown as readonly ChartRow[];
  const errors = ErrorsSchema.parse(parseJson(r.validation_errors)) as unknown as readonly ChartError[];
  return {
    id: r.id,
    storeId: r.store_id,
    productType: r.product_type,
    chartVersion: r.chart_version,
    unitEntered: r.unit_entered,
    rows,
    validated: r.validated,
    validationErrors: errors,
    createdAtMs: ms(r.created_ms),
  };
}

export class KyselySizeChartRepository implements SizeChartRepository {
  constructor(private readonly db: SizingDb) {}

  async nextVersion(storeId: string, productType: string): Promise<number> {
    return inTx(this.db, async (trx) => {
      const r = await sql<{ v: number }>`select (coalesce(max(chart_version), 0) + 1)::int as v from size_charts
        where store_id = ${storeId}::uuid and product_type = ${productType}`.execute(trx);
      return r.rows[0]?.v ?? 1;
    });
  }

  /** Immutable rows: a concurrent insert of the same version fails on the unique constraint. */
  async insert(chart: StoredChart): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`
        insert into size_charts (id, store_id, product_type, chart_version, unit_entered, rows, validated, validation_errors, created_at)
        values (${chart.id}::uuid, ${chart.storeId}::uuid, ${chart.productType}, ${chart.chartVersion}, ${chart.unitEntered},
                ${JSON.stringify(chart.rows)}::jsonb, ${chart.validated}, ${JSON.stringify(chart.validationErrors)}::jsonb,
                ${ts(chart.createdAtMs)}::timestamptz)`.execute(trx);
    });
  }

  async listForStore(storeId: string, page: { cursor: string | null; limit: number }): Promise<Page<StoredChart> | "invalid_cursor"> {
    const after = decodeCursor(page.cursor, storeId);
    if (after === "invalid") return "invalid_cursor";
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`select ${CHART_COLS} from size_charts
        where store_id = ${storeId}::uuid
          and (${after === null ? null : ts(after.ms)}::timestamptz is null
               or (created_at, chart_version, id) > (${after === null ? null : ts(after.ms)}::timestamptz, ${after?.seq ?? null}::int, ${after?.id ?? null}::uuid))
        order by created_at, chart_version, id limit ${page.limit + 1}`.execute(trx);
      const all = r.rows.map(toChart);
      const items = all.slice(0, page.limit);
      const last = items[items.length - 1];
      return { items, nextCursor: all.length > page.limit && last !== undefined ? encodeCursor(last.createdAtMs, last.chartVersion, last.id, storeId) : null };
    });
  }

  async latestValidated(storeId: string, productType: string): Promise<StoredChart | null> {
    return inTx(this.db, async (trx) => {
      const r = await sql<unknown>`select ${CHART_COLS} from size_charts
        where store_id = ${storeId}::uuid and product_type = ${productType} and validated
        order by chart_version desc limit 1`.execute(trx);
      const row = r.rows[0];
      return row === undefined ? null : toChart(row);
    });
  }
}

const RATING_TO_DB: Readonly<Record<FitRating, string>> = { too_small: "TOO_SMALL", ok: "OK", too_large: "TOO_LARGE" };

export class KyselyFeedbackRepository implements FeedbackRepository {
  constructor(private readonly db: SizingDb) {}

  async insert(record: FeedbackRecord): Promise<"created" | "duplicate"> {
    return inTx(this.db, async (trx) => {
      const r = await sql<{ id: string }>`
        insert into fit_feedback (id, order_line_id, user_id, profile_id, product_id, brand_id, product_type, size_chart_id,
                                  size_label, rating, area, submitted_at)
        values (${record.id}::uuid, ${record.orderLineId}::uuid, ${record.userId}::uuid, ${record.profileId}::uuid,
                ${record.productId}::uuid, ${record.brandId}::uuid, ${record.productType}, ${record.sizeChartId}::uuid,
                ${record.sizeLabel}, ${RATING_TO_DB[record.rating]}, ${record.area === null ? null : record.area.toUpperCase()},
                ${ts(record.submittedAtMs)}::timestamptz)
        on conflict (order_line_id) do nothing
        returning id::text as id`.execute(trx);
      return r.rows.length > 0 ? ("created" as const) : ("duplicate" as const);
    });
  }

  async historyFor(userId: string, brandId: string): Promise<BrandHistory> {
    return inTx(this.db, async (trx) => {
      const r = await sql<{ small: number; large: number }>`
        select count(*) filter (where rating = 'TOO_SMALL')::int as small, count(*) filter (where rating = 'TOO_LARGE')::int as large
          from fit_feedback where user_id = ${userId}::uuid and brand_id = ${brandId}::uuid`.execute(trx);
      return { tooSmall: r.rows[0]?.small ?? 0, tooLarge: r.rows[0]?.large ?? 0 };
    });
  }

  async itemCounts(productId: string, sizeChartId: string): Promise<ItemCounts> {
    return inTx(this.db, async (trx) => {
      const r = await sql<{ small: number; ok: number; large: number }>`
        select count(*) filter (where rating = 'TOO_SMALL')::int as small,
               count(*) filter (where rating = 'OK')::int as ok,
               count(*) filter (where rating = 'TOO_LARGE')::int as large
          from fit_feedback where product_id = ${productId}::uuid and size_chart_id = ${sizeChartId}::uuid`.execute(trx);
      const row = r.rows[0];
      return { nSmall: row?.small ?? 0, nOk: row?.ok ?? 0, nLarge: row?.large ?? 0 };
    });
  }

  async detachProfile(userId: string, profileId: string): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`update fit_feedback set profile_id = null where user_id = ${userId}::uuid and profile_id = ${profileId}::uuid`.execute(trx);
    });
  }
}

/** `YYYY-Www` (ISO, Monday based) to the Monday date `YYYY-MM-DD`. */
export function isoWeekToMonday(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (m === null) throw new RangeError("invalid ISO week");
  const year = Number(m[1]);
  const w = Number(m[2]);
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Dow = (new Date(jan4).getUTCDay() + 6) % 7;
  const monday = jan4 - jan4Dow * 86_400_000 + (w - 1) * 7 * 86_400_000;
  return new Date(monday).toISOString().slice(0, 10);
}

/** Monday date `YYYY-MM-DD` back to `YYYY-Www`. */
export function mondayToIsoWeek(date: string): string {
  const t = Date.parse(`${date}T00:00:00Z`);
  const d = new Date(t);
  const thursday = new Date(t + (3 - ((d.getUTCDay() + 6) % 7)) * 86_400_000);
  const jan1 = Date.UTC(thursday.getUTCFullYear(), 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / (7 * 86_400_000)) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export const K_ANONYMITY_MIN = 50;

export class KyselyDemandRepository implements DemandRepository {
  /** `pseudonymKey` is a server-side secret (KMS in production): shopper ids are HMACed before they touch a row. */
  constructor(
    private readonly db: SizingDb,
    private readonly pseudonymKey: Uint8Array,
  ) {}

  private hash(shopperId: string): string {
    return createHmac("sha256", this.pseudonymKey).update(shopperId, "utf8").digest("hex");
  }

  /** Idempotent per (cell, shopper) through the primary key: a repeat is a no-op. */
  async record(storeId: string, productType: string, sizeLabel: string, week: string, shopperId: string): Promise<void> {
    await inTx(this.db, async (trx) => {
      await sql`
        insert into size_demand_events (store_id, product_type, size_label, week_start, shopper_hash)
        values (${storeId}::uuid, ${productType}, ${sizeLabel}, ${isoWeekToMonday(week)}::date, ${this.hash(shopperId)})
        on conflict do nothing`.execute(trx);
    });
  }

  /** demandCount = count(DISTINCT shopper): people, never requests. */
  async cellsForStore(storeId: string): Promise<readonly { productType: string; sizeLabel: string; week: string; demandCount: number }[]> {
    return inTx(this.db, async (trx) => {
      const r = await sql<{ product_type: string; size_label: string; week_start: string; n: number }>`
        select product_type, size_label, week_start::text as week_start, count(distinct shopper_hash)::int as n
          from size_demand_events where store_id = ${storeId}::uuid
         group by product_type, size_label, week_start
         order by week_start, product_type, size_label`.execute(trx);
      return r.rows.map((x) => ({
        productType: x.product_type,
        sizeLabel: x.size_label,
        week: mondayToIsoWeek(x.week_start),
        demandCount: x.n,
      }));
    });
  }

  /**
   * Rolls one week into seller_size_demand_agg, keeping only cells with at least `k` DISTINCT
   * shoppers (k-anonymity enforced in SQL, the table CHECK is the second line of defence).
   * Returns the number of cells written. Safe to re-run.
   */
  async materializeAggregates(week: string, k: number = K_ANONYMITY_MIN): Promise<number> {
    if (!Number.isInteger(k) || k < K_ANONYMITY_MIN) throw new RangeError(`k must be an integer >= ${K_ANONYMITY_MIN}`);
    return inTx(this.db, async (trx) => {
      const r = await sql<{ store_id: string }>`
        insert into seller_size_demand_agg (store_id, product_type, size_label, week_start, demand_count)
        select store_id, product_type, size_label, week_start, count(distinct shopper_hash)::int
          from size_demand_events where week_start = ${isoWeekToMonday(week)}::date
         group by store_id, product_type, size_label, week_start
        having count(distinct shopper_hash) >= ${k}
        on conflict (store_id, product_type, size_label, week_start) do update set demand_count = excluded.demand_count
        returning store_id::text as store_id`.execute(trx);
      return r.rows.length;
    });
  }
}

