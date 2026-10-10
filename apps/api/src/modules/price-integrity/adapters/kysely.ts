import { sql, type Transaction } from "kysely";
import { z } from "zod";
import type { KyselyTransactionRunner, PlatformTables, RlsSession } from "../../../platform/db";
import {
  PRICE_EVENT_SOURCES,
  VIOLATION_KINDS,
  type EnforcementAction,
  type ExternalEvidence,
  type PriceEvent,
  type ViolationKind,
} from "../domain/domain";
import {
  PriceEventConflictError,
  type ClaimRecord,
  type ClaimStats,
  type ClaimStore,
  type EnforcementRecord,
  type EnforcementStore,
  type ExternalEvidencePort,
  type NewPriceEvent,
  type PriceEventStore,
} from "../domain/ports";

/** Raw SQL with Zod-validated rows (same approach as inventory and wishlists, ADR-0020). */
export type PriceIntegrityDb = PlatformTables;
export type SessionProvider = () => RlsSession;

/** Scoring writes (claims, enforcement) are a platform function, never done as the seller. */
export const SYSTEM_SESSION: RlsSession = { userId: null, role: "system" };

const Int = z.string().regex(/^-?\d+$/);
const Ms = Int.transform((s) => Number(s));
const Big = Int.transform((s) => BigInt(s));

const EventRow = z.object({
  id: z.string(),
  sku_id: z.string(),
  store_id: z.string(),
  price_amount: Big,
  valid_ms: Ms,
  source: z.enum(PRICE_EVENT_SOURCES),
  actor_id: z.string().nullable(),
  idempotency_key: z.string(),
});

const EVENT_COLS = sql`id::text as id, sku_id::text as sku_id, store_id::text as store_id, price_amount::text as price_amount,
  floor(extract(epoch from valid_from) * 1000)::text as valid_ms, source, actor_id::text as actor_id, idempotency_key`;

const toEvent = (r: z.output<typeof EventRow>): PriceEvent => ({
  id: r.id,
  skuId: r.sku_id,
  priceAmount: r.price_amount,
  validFromMs: r.valid_ms,
  source: r.source,
  actorId: r.actor_id,
});

const iso = (ms: number): string => new Date(ms).toISOString();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidList = (ids: readonly string[]) => sql.join(ids.map((i) => sql`${i}::uuid`));

abstract class Base {
  constructor(
    protected readonly runner: KyselyTransactionRunner<PriceIntegrityDb>,
    protected readonly session: SessionProvider,
  ) {}
  protected run<T>(process: string, fn: (db: Transaction<PriceIntegrityDb>) => Promise<T>, session: RlsSession = this.session()): Promise<T> {
    return this.runner.run({ session, process, profile: "default" }, (tx) => fn(tx.db));
  }
}

export class KyselyPriceEventStore extends Base implements PriceEventStore {
  async append(e: NewPriceEvent): Promise<{ event: PriceEvent; created: boolean }> {
    return this.run("price_integrity.append", async (db) => {
      const latest = await sql<{ valid_ms: string; store_id: string }>`
        select floor(extract(epoch from valid_from) * 1000)::text as valid_ms, store_id::text as store_id
        from price_events where sku_id = ${e.skuId}::uuid order by valid_from desc, id desc limit 1`.execute(db);
      const existing = await sql`select ${EVENT_COLS} from price_events where sku_id = ${e.skuId}::uuid and idempotency_key = ${e.idempotencyKey}`.execute(db);
      const found = existing.rows[0];
      if (found !== undefined) {
        const row = EventRow.parse(found);
        if (row.price_amount !== e.priceAmount || row.valid_ms !== e.validFromMs || row.store_id !== e.storeId) {
          throw new PriceEventConflictError("idempotency_conflict", "idempotency key reused with a different payload");
        }
        return { event: toEvent(row), created: false };
      }
      const l = latest.rows[0];
      if (l !== undefined) {
        if (l.store_id !== e.storeId) throw new PriceEventConflictError("store_mismatch", "sku belongs to another store");
        if (e.validFromMs < Number(l.valid_ms)) throw new PriceEventConflictError("out_of_order", "price event is older than the latest event");
      }
      const inserted = await sql`
        insert into price_events (id, sku_id, store_id, price_amount, valid_from, source, actor_id, idempotency_key)
        values (${e.id}::uuid, ${e.skuId}::uuid, ${e.storeId}::uuid, ${e.priceAmount.toString()}::bigint, ${iso(e.validFromMs)}::timestamptz,
                ${e.source}, ${e.actorId}::uuid, ${e.idempotencyKey})
        returning ${EVENT_COLS}`.execute(db);
      return { event: toEvent(EventRow.parse(inserted.rows[0])), created: true };
    });
  }

  async history(skuId: string): Promise<readonly PriceEvent[]> {
    if (!UUID.test(skuId)) return [];
    return this.run("price_integrity.history", async (db) => {
      const r = await sql`select ${EVENT_COLS} from price_events where sku_id = ${skuId}::uuid order by valid_from, id`.execute(db);
      return r.rows.map((x) => toEvent(EventRow.parse(x)));
    });
  }

  async historyMany(skuIds: readonly string[]): Promise<ReadonlyMap<string, readonly PriceEvent[]>> {
    const ids = [...new Set(skuIds)].filter((i) => UUID.test(i));
    const out = new Map<string, PriceEvent[]>();
    if (ids.length === 0) return out;
    return this.run("price_integrity.history_many", async (db) => {
      const r = await sql`select ${EVENT_COLS} from price_events where sku_id in (${uuidList(ids)}) order by sku_id, valid_from, id`.execute(db);
      for (const raw of r.rows) {
        const row = EventRow.parse(raw);
        const list = out.get(row.sku_id) ?? [];
        list.push(toEvent(row));
        out.set(row.sku_id, list);
      }
      return out;
    });
  }

  async storeOf(skuId: string): Promise<string | null> {
    if (!UUID.test(skuId)) return null;
    return this.run("price_integrity.store_of", async (db) => {
      const r = await sql<{ store_id: string }>`select store_id::text as store_id from price_events where sku_id = ${skuId}::uuid limit 1`.execute(db);
      return r.rows[0]?.store_id ?? null;
    });
  }
}

export class KyselyClaimStore extends Base implements ClaimStore {
  async record(c: ClaimRecord): Promise<boolean> {
    const evidence = c.evidenceIds.length === 0 ? sql`'{}'::text[]` : sql`array[${sql.join(c.evidenceIds.map((i) => sql`${i}`))}]::text[]`;
    return this.run(
      "price_integrity.claim_record",
      async (db) => {
        const r = await sql`
          insert into price_claims (id, sku_id, store_id, status, price_amount, vrp_amount, discount_pct, evidence_ids, reason, computed_at)
          values (${c.id}::uuid, ${c.skuId}::uuid, ${c.storeId}::uuid, ${c.status}, ${c.priceAmount.toString()}::bigint,
                  ${c.vrpAmount === null ? null : c.vrpAmount.toString()}::bigint, ${c.discountPct}::integer, ${evidence}, ${c.reason},
                  ${iso(c.computedAtMs)}::timestamptz)
          on conflict (id) do nothing returning id`.execute(db);
        return r.rows.length === 1;
      },
      SYSTEM_SESSION,
    );
  }

  async statsSince(storeId: string, sinceMs: number): Promise<ClaimStats> {
    if (!UUID.test(storeId)) return { evaluated: 0, verified: 0 };
    return this.run("price_integrity.claim_stats", async (db) => {
      const r = await sql<{ evaluated: string; verified: string }>`
        select count(*)::text as evaluated, (count(*) filter (where status = 'verified_discount'))::text as verified
        from price_claims where store_id = ${storeId}::uuid and computed_at >= ${iso(sinceMs)}::timestamptz`.execute(db);
      const row = r.rows[0];
      return { evaluated: Number(row?.evaluated ?? 0), verified: Number(row?.verified ?? 0) };
    });
  }
}

const ActionsSchema = z.array(z.looseObject({ kind: z.string() }));
const EnfRow = z.object({
  id: z.string(),
  store_id: z.string(),
  sku_id: z.string().nullable(),
  kind: z.enum(VIOLATION_KINDS),
  actions: z.unknown(),
  violations_in_window: z.number().int(),
  dedupe_key: z.string(),
  opened_ms: Ms,
  resolved_ms: Ms.nullable(),
});
const ENF_COLS = sql`id::text as id, store_id::text as store_id, sku_id::text as sku_id, kind, actions, violations_in_window, dedupe_key,
  floor(extract(epoch from opened_at) * 1000)::text as opened_ms, floor(extract(epoch from resolved_at) * 1000)::text as resolved_ms`;

export class KyselyEnforcementStore extends Base implements EnforcementStore {
  async record(r: EnforcementRecord): Promise<boolean> {
    return this.run(
      "price_integrity.enforcement_record",
      async (db) => {
        const res = await sql`
          insert into price_enforcement_actions (id, store_id, sku_id, kind, actions, violations_in_window, dedupe_key, opened_at, resolved_at)
          values (${r.id}::uuid, ${r.storeId}::uuid, ${r.skuId}::uuid, ${r.kind}, ${JSON.stringify(r.actions)}::jsonb, ${r.violationsInWindow},
                  ${r.dedupeKey}, ${iso(r.openedAtMs)}::timestamptz, ${r.resolvedAtMs === null ? null : iso(r.resolvedAtMs)}::timestamptz)
          on conflict do nothing returning id`.execute(db);
        return res.rows.length === 1;
      },
      SYSTEM_SESSION,
    );
  }

  private async count(storeId: string, kind: ViolationKind | null, sinceMs: number): Promise<number> {
    if (!UUID.test(storeId)) return 0;
    return this.run("price_integrity.enforcement_count", async (db) => {
      const r = await sql<{ n: string }>`
        select count(*)::text as n from price_enforcement_actions
        where store_id = ${storeId}::uuid and opened_at >= ${iso(sinceMs)}::timestamptz
          and (${kind}::text is null or kind = ${kind}::text)`.execute(db);
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  countSince(storeId: string, sinceMs: number): Promise<number> {
    return this.count(storeId, null, sinceMs);
  }

  countKindSince(storeId: string, kind: ViolationKind, sinceMs: number): Promise<number> {
    return this.count(storeId, kind, sinceMs);
  }

  async openCrossChannelSince(skuId: string): Promise<number | null> {
    if (!UUID.test(skuId)) return null;
    return this.run("price_integrity.open_finding", async (db) => {
      const r = await sql<{ ms: string }>`
        select floor(extract(epoch from opened_at) * 1000)::text as ms from price_enforcement_actions
        where sku_id = ${skuId}::uuid and kind = 'cross_channel_cheaper' and resolved_at is null limit 1`.execute(db);
      const row = r.rows[0];
      return row === undefined ? null : Number(row.ms);
    });
  }

  async resolveCrossChannel(skuId: string, atMs: number): Promise<number> {
    return this.run(
      "price_integrity.resolve_finding",
      async (db) => {
        const r = await sql`
          update price_enforcement_actions set resolved_at = ${iso(atMs)}::timestamptz
          where sku_id = ${skuId}::uuid and kind = 'cross_channel_cheaper' and resolved_at is null returning id`.execute(db);
        return r.rows.length;
      },
      SYSTEM_SESSION,
    );
  }

  async openCrossChannelCount(storeId: string): Promise<number> {
    if (!UUID.test(storeId)) return 0;
    return this.run("price_integrity.open_findings", async (db) => {
      const r = await sql<{ n: string }>`
        select count(*)::text as n from price_enforcement_actions
        where store_id = ${storeId}::uuid and kind = 'cross_channel_cheaper' and resolved_at is null`.execute(db);
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  async recent(storeId: string, limit: number): Promise<readonly EnforcementRecord[]> {
    if (!UUID.test(storeId)) return [];
    const n = Math.min(Math.max(Math.trunc(limit), 1), 100);
    return this.run("price_integrity.recent_actions", async (db) => {
      const r = await sql`select ${ENF_COLS} from price_enforcement_actions where store_id = ${storeId}::uuid
        order by opened_at desc, id desc limit ${n}`.execute(db);
      return r.rows.map((raw) => {
        const row = EnfRow.parse(raw);
        const actions = ActionsSchema.parse(row.actions) as unknown as EnforcementAction[];
        return {
          id: row.id,
          storeId: row.store_id,
          skuId: row.sku_id,
          kind: row.kind,
          actions,
          violationsInWindow: row.violations_in_window,
          dedupeKey: row.dedupe_key,
          openedAtMs: row.opened_ms,
          resolvedAtMs: row.resolved_ms,
        };
      });
    });
  }
}

export type { ExternalEvidence, ExternalEvidencePort };
