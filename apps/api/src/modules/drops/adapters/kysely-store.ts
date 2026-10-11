import { sql, type Kysely } from "kysely";
import { z } from "zod";
import { DROP_STATES, DROP_TYPES, type Drop, type DropItem } from "../domain/bridge";
import type {
  DropOutboxEvent,
  DropStore,
  IdPort,
  KeysetPosition,
  PurchaseRecord,
  SaveResult,
} from "../domain/ports";

export type DropDb = Kysely<Record<string, never>>;

const Ms = z.string().regex(/^-?\d+$/).transform((s) => Number(s));
const Big = z.string().regex(/^\d+$/).transform((s) => BigInt(s));
const Limits = z.object({ per_user: z.number().int(), per_device: z.number().int() });
const Ladder = z.array(z.object({ at_ms: z.number().int(), price: z.string().regex(/^\d+$/) }));
const Mystery = z.object({ min: z.string().regex(/^\d+$/), max: z.string().regex(/^\d+$/), guaranteed: z.string().regex(/^\d+$/) });

const DropRow = z.object({
  id: z.string(),
  store_id: z.string(),
  type: z.enum(DROP_TYPES),
  state: z.enum(DROP_STATES),
  title: z.string(),
  starts_ms: Ms,
  early_ms: Ms.nullable(),
  ends_ms: Ms,
  admit_per_sec: z.number().int(),
  limits: Limits,
  ladder: Ladder,
  mystery: Mystery.nullable(),
  paused: z.boolean(),
  version: z.number().int(),
  created_ms: Ms,
  updated_ms: Ms,
});
const ItemRow = z.object({ drop_id: z.string(), sku_id: z.string(), stock_cap: z.number().int(), price: Big });

const COLS = sql`
  id::text as id, store_id::text as store_id, type, state, title,
  (extract(epoch from starts_at) * 1000)::bigint::text as starts_ms,
  (extract(epoch from early_access_at) * 1000)::bigint::text as early_ms,
  (extract(epoch from ends_at) * 1000)::bigint::text as ends_ms,
  admit_per_sec, limits, ladder, mystery, paused, version,
  (extract(epoch from created_at) * 1000)::bigint::text as created_ms,
  (extract(epoch from updated_at) * 1000)::bigint::text as updated_ms`;

const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

const eventDropId = (e: DropOutboxEvent): string => e.dropId;

/** Postgres adapter: one transaction per call under the `system` role, outbox in the same tx. */
export class KyselyDropStore implements DropStore {
  constructor(
    private readonly db: DropDb,
    private readonly ids: IdPort,
  ) {}

  private async tx<T>(run: (trx: DropDb) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      return run(trx as unknown as DropDb);
    });
  }

  private async emit(trx: DropDb, events: readonly DropOutboxEvent[]): Promise<void> {
    for (const e of events) {
      const id = eventDropId(e);
      await sql`
        insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
        values (${this.ids.uuidV7()}::uuid, 'drop', ${id}::uuid, ${e.type}, ${`drop:${id}`}, ${JSON.stringify(e)}::jsonb)`.execute(trx);
    }
  }

  private async writeItems(trx: DropDb, d: Drop): Promise<void> {
    await sql`delete from drop_items where drop_id = ${d.id}::uuid`.execute(trx);
    for (const it of d.items) {
      await sql`insert into drop_items (drop_id, sku_id, stock_cap, price)
                values (${d.id}::uuid, ${it.skuId}::uuid, ${it.stockCap}, ${it.pricePiastres.toString()}::bigint)`.execute(trx);
    }
  }

  private ladderJson = (d: Drop): string =>
    JSON.stringify(d.ladder.map((s) => ({ at_ms: s.atMs, price: s.pricePiastres.toString() })));
  private mysteryJson = (d: Drop): string | null =>
    d.mystery === null
      ? null
      : JSON.stringify({
          min: d.mystery.minValuePiastres.toString(),
          max: d.mystery.maxValuePiastres.toString(),
          guaranteed: d.mystery.guaranteedMinPiastres.toString(),
        });

  async insert(d: Drop, events: readonly DropOutboxEvent[]): Promise<void> {
    await this.tx(async (trx) => {
      await sql`
        insert into drops (id, store_id, type, state, title, starts_at, early_access_at, ends_at, admit_per_sec,
                           limits, ladder, mystery, paused, version, created_at, updated_at)
        values (${d.id}::uuid, ${d.storeId}::uuid, ${d.type}, ${d.state}, ${d.title}, ${iso(d.startsAtMs)}::timestamptz,
                ${isoOrNull(d.earlyAccessAtMs)}::timestamptz, ${iso(d.endsAtMs)}::timestamptz, ${d.admitPerSec},
                ${JSON.stringify({ per_user: d.limits.perUser, per_device: d.limits.perDevice })}::jsonb,
                ${this.ladderJson(d)}::jsonb, ${this.mysteryJson(d)}::jsonb, ${d.paused}, ${d.version},
                ${iso(d.createdAtMs)}::timestamptz, ${iso(d.updatedAtMs)}::timestamptz)`.execute(trx);
      await this.writeItems(trx, d);
      await this.emit(trx, events);
    });
  }

  private async hydrate(trx: DropDb, rows: readonly unknown[]): Promise<Drop[]> {
    const parsed = rows.map((r) => DropRow.parse(r));
    if (parsed.length === 0) return [];
    const ids = parsed.map((p) => p.id);
    const items = await sql<unknown>`
      select drop_id::text as drop_id, sku_id::text as sku_id, stock_cap, price::text as price
      from drop_items where drop_id = any(${ids}::uuid[]) order by sku_id`.execute(trx);
    const by = new Map<string, DropItem[]>();
    for (const raw of items.rows) {
      const r = ItemRow.parse(raw);
      const list = by.get(r.drop_id) ?? [];
      list.push({ skuId: r.sku_id, stockCap: r.stock_cap, pricePiastres: r.price });
      by.set(r.drop_id, list);
    }
    return parsed.map((p) => ({
      id: p.id,
      storeId: p.store_id,
      type: p.type,
      state: p.state,
      title: p.title,
      startsAtMs: p.starts_ms,
      earlyAccessAtMs: p.early_ms,
      endsAtMs: p.ends_ms,
      items: by.get(p.id) ?? [],
      limits: { perUser: p.limits.per_user, perDevice: p.limits.per_device },
      ladder: p.ladder.map((s) => ({ atMs: s.at_ms, pricePiastres: BigInt(s.price) })),
      mystery:
        p.mystery === null
          ? null
          : {
              minValuePiastres: BigInt(p.mystery.min),
              maxValuePiastres: BigInt(p.mystery.max),
              guaranteedMinPiastres: BigInt(p.mystery.guaranteed),
            },
      admitPerSec: p.admit_per_sec,
      paused: p.paused,
      createdAtMs: p.created_ms,
      updatedAtMs: p.updated_ms,
      version: p.version,
    }));
  }

  async get(id: string): Promise<Drop | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${COLS} from drops where id = ${id}::uuid`.execute(trx);
      return (await this.hydrate(trx, r.rows))[0] ?? null;
    });
  }

  async save(next: Drop, expectedVersion: number, events: readonly DropOutboxEvent[]): Promise<SaveResult> {
    return this.tx(async (trx) => {
      const upd = await sql<{ id: string }>`
        update drops set state = ${next.state}, title = ${next.title}, starts_at = ${iso(next.startsAtMs)}::timestamptz,
          early_access_at = ${isoOrNull(next.earlyAccessAtMs)}::timestamptz, ends_at = ${iso(next.endsAtMs)}::timestamptz,
          admit_per_sec = ${next.admitPerSec},
          limits = ${JSON.stringify({ per_user: next.limits.perUser, per_device: next.limits.perDevice })}::jsonb,
          ladder = ${this.ladderJson(next)}::jsonb, mystery = ${this.mysteryJson(next)}::jsonb,
          paused = ${next.paused}, version = version + 1, updated_at = ${iso(next.updatedAtMs)}::timestamptz
        where id = ${next.id}::uuid and version = ${expectedVersion}
        returning id::text as id`.execute(trx);
      if (upd.rows[0] === undefined) {
        const ex = await sql<{ id: string }>`select id::text as id from drops where id = ${next.id}::uuid`.execute(trx);
        return ex.rows[0] === undefined ? "not_found" : "conflict";
      }
      await this.writeItems(trx, next);
      await this.emit(trx, events);
      return "ok";
    });
  }

  async removeDraft(id: string): Promise<boolean> {
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`delete from drops where id = ${id}::uuid and state = 'DRAFT' returning id::text as id`.execute(trx);
      return r.rows[0] !== undefined;
    });
  }

  async listPublic(after: KeysetPosition | null, limit: number): Promise<readonly Drop[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${COLS} from drops
        where state not in ('DRAFT', 'ARCHIVED')
          and (${after === null}::boolean or (starts_at, id) < (${iso(after?.startsAtMs ?? 0)}::timestamptz, ${after?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
        order by starts_at desc, id desc limit ${limit}`.execute(trx);
      return this.hydrate(trx, r.rows);
    });
  }

  async listByStores(storeIds: readonly string[], after: KeysetPosition | null, limit: number): Promise<readonly Drop[]> {
    if (storeIds.length === 0) return [];
    return this.tx(async (trx) => {
      const r = await sql<unknown>`
        select ${COLS} from drops
        where store_id = any(${[...storeIds]}::uuid[])
          and (${after === null}::boolean or (starts_at, id) < (${iso(after?.startsAtMs ?? 0)}::timestamptz, ${after?.id ?? "00000000-0000-0000-0000-000000000000"}::uuid))
        order by starts_at desc, id desc limit ${limit}`.execute(trx);
      return this.hydrate(trx, r.rows);
    });
  }

  async active(): Promise<readonly Drop[]> {
    return this.tx(async (trx) => {
      const r = await sql<unknown>`select ${COLS} from drops where state in ('SCHEDULED', 'EARLY_ACCESS', 'LIVE') order by starts_at, id`.execute(trx);
      return this.hydrate(trx, r.rows);
    });
  }

  async addWaitlist(dropId: string, userId: string, nowMs: number, events: readonly DropOutboxEvent[]): Promise<"added" | "exists"> {
    return this.tx(async (trx) => {
      const r = await sql<{ u: string }>`
        insert into drop_waitlist (drop_id, user_id, created_at) values (${dropId}::uuid, ${userId}::uuid, ${iso(nowMs)}::timestamptz)
        on conflict do nothing returning user_id::text as u`.execute(trx);
      if (r.rows[0] === undefined) return "exists";
      await this.emit(trx, events);
      return "added";
    });
  }

  async waitlistSize(dropId: string): Promise<number> {
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`select count(*)::text as n from drop_waitlist where drop_id = ${dropId}::uuid`.execute(trx);
      return Number(r.rows[0]?.n ?? 0);
    });
  }

  async purchased(dropId: string, skuId: string, userId: string, deviceHash: string) {
    return this.tx(async (trx) => {
      const r = await sql<{ u: string; d: string }>`
        select coalesce(sum(qty) filter (where user_id = ${userId}::uuid), 0)::text as u,
               coalesce(sum(qty) filter (where device_hash = ${deviceHash}), 0)::text as d
        from drop_purchases where drop_id = ${dropId}::uuid and sku_id = ${skuId}::uuid and released_at is null`.execute(trx);
      return { byUser: Number(r.rows[0]?.u ?? 0), byDevice: Number(r.rows[0]?.d ?? 0) };
    });
  }

  async recordPurchase(p: PurchaseRecord, events: readonly DropOutboxEvent[]): Promise<"recorded" | "exists"> {
    return this.tx(async (trx) => {
      const r = await sql<{ id: string }>`
        insert into drop_purchases (id, drop_id, sku_id, user_id, device_hash, qty, reservation_id, created_at)
        values (${p.reservationId}::uuid, ${p.dropId}::uuid, ${p.skuId}::uuid, ${p.userId}::uuid, ${p.deviceHash}, ${p.qty},
                ${p.reservationId}::uuid, ${iso(p.createdAtMs)}::timestamptz)
        on conflict (reservation_id) do nothing returning id::text as id`.execute(trx);
      if (r.rows[0] === undefined) return "exists";
      await this.emit(trx, events);
      return "recorded";
    });
  }

  async releasePurchase(reservationId: string, nowMs: number): Promise<PurchaseRecord | null> {
    return this.tx(async (trx) => {
      const r = await sql<{ drop_id: string; sku_id: string; user_id: string; device_hash: string; qty: number; created_ms: string }>`
        update drop_purchases set released_at = ${iso(nowMs)}::timestamptz
        where reservation_id = ${reservationId}::uuid and released_at is null
        returning drop_id::text as drop_id, sku_id::text as sku_id, user_id::text as user_id, device_hash, qty,
                  (extract(epoch from created_at) * 1000)::bigint::text as created_ms`.execute(trx);
      const row = r.rows[0];
      if (row === undefined) return null;
      return {
        reservationId,
        dropId: row.drop_id,
        skuId: row.sku_id,
        userId: row.user_id,
        deviceHash: row.device_hash,
        qty: row.qty,
        createdAtMs: Number(row.created_ms),
      };
    });
  }

  async boughtSince(dropId: string, sinceMs: number): Promise<number> {
    return this.tx(async (trx) => {
      const r = await sql<{ n: string }>`
        select coalesce(sum(qty), 0)::text as n from drop_purchases
        where drop_id = ${dropId}::uuid and released_at is null and created_at >= ${iso(sinceMs)}::timestamptz`.execute(trx);
      return Number(r.rows[0]?.n ?? 0);
    });
  }
}
