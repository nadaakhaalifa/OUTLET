import { sql, type Kysely } from "kysely";
import { z } from "zod";
import {
  PAYMENT_METHODS,
  RESERVATION_STATUSES,
  type ClaimOutcome,
  type LevelView,
  type ReleaseOutcome,
  type ReleaseReason,
  type ReserveOutcome,
  type SweepResult,
  type SyncCommand,
  type SyncOutcome,
  type TransferCommand,
  type TransferOutcome,
  type TtlPolicy,
} from "../domain/core";
import type { InventoryStore, PoolIds, ReserveCommand, SkuDirectory, SkuLocation } from "../domain/ports";
import { FAWRY_POOL_ID, STANDARD_POOL_ID } from "./in-memory";

/** Raw SQL only: the stock logic lives in migration 0016's functions, not in query builders. */
export type InventoryDb = Kysely<Record<string, never>>;

const Short = z.object({
  sku_id: z.string(),
  location_id: z.string(),
  requested: z.number().int(),
  available: z.number().int(),
});

const ReserveResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("reserved"), reservation_id: z.string(), expires_at: z.string(), replayed: z.boolean() }),
  z.object({ status: z.literal("insufficient"), shortfalls: z.array(Short) }),
  z.object({ status: z.literal("conflict") }),
  z.object({ status: z.literal("closed"), reservation_status: z.enum(RESERVATION_STATUSES) }),
]);

const ClaimResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("claimed") }),
  z.object({ status: z.literal("claimed_late") }),
  z.object({ status: z.literal("already_claimed") }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("unavailable"), shortfalls: z.array(Short) }),
]);

const ReleaseResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("released") }),
  z.object({ status: z.literal("not_found") }),
  z.object({ status: z.literal("noop"), reservation_status: z.enum(RESERVATION_STATUSES) }),
]);

const SweepResultSchema = z.object({ expired_reservations: z.number().int(), released_units: z.number().int() });

const SyncResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("applied"),
    replayed: z.boolean(),
    on_hand: z.number().int(),
    committed: z.number().int(),
    reserved: z.number().int(),
    available: z.number().int(),
    sync_version: z.number().int(),
    updated_at: z.string(),
    oversold_units: z.number().int(),
  }),
  z.object({ status: z.literal("stale"), current_source_version: z.number().int() }),
  z.object({ status: z.literal("version_conflict"), current_version: z.number().int() }),
  z.object({ status: z.literal("negative"), would_be: z.number() }),
]);

const TransferResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("transferred"), replayed: z.boolean() }),
  z.object({ status: z.literal("insufficient"), free: z.number().int() }),
  z.object({ status: z.literal("invalid") }),
]);

const PolicyRow = z.object({
  id: z.string(),
  payment_method: z.enum(PAYMENT_METHODS),
  ttl_seconds: z.number().int(),
  extension_seconds: z.number().int(),
  pool_kind: z.enum(["STANDARD", "FAWRY"]),
  max_qty_per_line: z.number().int().nullable(),
  version: z.number().int(),
});

const iso = (ms: number): string => new Date(ms).toISOString();

/** Postgres adapter. Every call is one transaction that runs under the `system` DB role (see 0016 header). */
export class KyselyInventoryStore implements InventoryStore {
  constructor(private readonly db: InventoryDb) {}

  private async tx<T>(run: (trx: InventoryDb) => Promise<T>, statementTimeoutMs?: number): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      if (statementTimeoutMs !== undefined) {
        await sql`select set_config('statement_timeout', ${String(statementTimeoutMs)}, true)`.execute(trx);
      }
      return run(trx as unknown as InventoryDb);
    });
  }

  async ttlPolicies(nowMs: number): Promise<readonly TtlPolicy[]> {
    const rows = await this.tx(async (trx) => {
      const r = await sql<unknown>`
        select id::text as id, payment_method, ttl_seconds, extension_seconds, pool_kind, max_qty_per_line, version
          from reservation_ttl_policies where valid_from <= ${iso(nowMs)}::timestamptz`.execute(trx);
      return r.rows;
    });
    return rows.map((raw) => {
      const r = PolicyRow.parse(raw);
      return {
        id: r.id,
        paymentMethod: r.payment_method,
        ttlSeconds: r.ttl_seconds,
        extensionSeconds: r.extension_seconds,
        poolKind: r.pool_kind,
        maxQtyPerLine: r.max_qty_per_line,
        version: r.version,
      };
    });
  }

  async poolIds(dropIds: readonly string[]): Promise<PoolIds> {
    const drops = new Map<string, string>();
    if (dropIds.length > 0) {
      const rows = await this.tx(async (trx) => {
        const r = await sql<unknown>`
          select id::text as id, drop_id::text as drop_id from stock_pools
           where kind = 'DROP' and drop_id::text = any (${dropIds as string[]})`.execute(trx);
        return r.rows;
      });
      for (const raw of rows) {
        const row = z.object({ id: z.string(), drop_id: z.string() }).parse(raw);
        drops.set(row.drop_id, row.id);
      }
    }
    return { standard: STANDARD_POOL_ID, fawry: FAWRY_POOL_ID, drops };
  }

  async reserve(cmd: ReserveCommand): Promise<ReserveOutcome> {
    const lines = cmd.plan.lines.map((l) => ({
      sku_id: l.skuId,
      location_id: l.locationId,
      pool_id: l.poolId,
      store_id: l.storeId,
      qty: l.qty,
    }));
    // Spec 20.2: statement timeout 2 s on the reserve path.
    const raw = await this.tx(async (trx) => {
      const r = await sql<{ result: unknown }>`
        select inventory_reserve(
          ${cmd.reservationId}::uuid, ${cmd.orderGroupId}::uuid, ${cmd.userId}::uuid,
          ${JSON.stringify(lines)}::jsonb, ${cmd.plan.ttlSeconds}::int, ${cmd.plan.ttlPolicyId}::uuid,
          ${cmd.plan.holdReason}, ${cmd.plan.fingerprint}, ${iso(cmd.nowMs)}::timestamptz) as result`.execute(trx);
      return r.rows[0]?.result;
    }, 2000);
    const res = ReserveResult.parse(raw);
    switch (res.status) {
      case "reserved":
        return { status: "reserved", reservationId: res.reservation_id, expiresAtMs: Date.parse(res.expires_at), replayed: res.replayed };
      case "insufficient":
        return {
          status: "insufficient",
          shortfalls: res.shortfalls.map((s) => ({
            skuId: s.sku_id,
            locationId: s.location_id,
            requested: s.requested,
            available: s.available,
          })),
        };
      case "conflict":
        return { status: "conflict" };
      case "closed":
        return { status: "closed", reservationStatus: res.reservation_status };
    }
  }

  async claim(orderGroupId: string, nowMs: number): Promise<ClaimOutcome> {
    const raw = await this.tx(async (trx) => {
      const r = await sql<{ result: unknown }>`
        select inventory_claim(${orderGroupId}::uuid, ${iso(nowMs)}::timestamptz) as result`.execute(trx);
      return r.rows[0]?.result;
    });
    const res = ClaimResult.parse(raw);
    if (res.status === "unavailable") {
      return {
        status: "unavailable",
        shortfalls: res.shortfalls.map((s) => ({
          skuId: s.sku_id,
          locationId: s.location_id,
          requested: s.requested,
          available: s.available,
        })),
      };
    }
    return { status: res.status };
  }

  async release(orderGroupId: string, reason: ReleaseReason, nowMs: number): Promise<ReleaseOutcome> {
    if (reason === "expired") throw new Error("expiry is released by sweepExpired only");
    const raw = await this.tx(async (trx) => {
      const r = await sql<{ result: unknown }>`
        select inventory_release(${orderGroupId}::uuid, ${reason}, ${iso(nowMs)}::timestamptz) as result`.execute(trx);
      return r.rows[0]?.result;
    });
    const res = ReleaseResult.parse(raw);
    return res.status === "noop" ? { status: "noop", reservationStatus: res.reservation_status } : { status: res.status };
  }

  async sweepExpired(nowMs: number, batch: number): Promise<SweepResult> {
    const raw = await this.tx(async (trx) => {
      const r = await sql<{ result: unknown }>`
        select inventory_sweep_expired(${iso(nowMs)}::timestamptz, ${batch}::int) as result`.execute(trx);
      return r.rows[0]?.result;
    });
    const res = SweepResultSchema.parse(raw);
    return { expiredReservations: res.expired_reservations, releasedUnits: res.released_units };
  }

  async replenishDue(limit: number): Promise<number> {
    const raw = await this.tx(async (trx) => {
      const r = await sql<{ n: number }>`select inventory_replenish_due(${limit}::int) as n`.execute(trx);
      return r.rows[0]?.n;
    });
    return z.number().int().parse(raw);
  }

  async applySync(cmd: SyncCommand): Promise<SyncOutcome> {
    const raw = await this.tx(async (trx) => {
      const r = await sql<{ result: unknown }>`
        select inventory_apply_stock_sync(
          ${cmd.skuId}::uuid, ${cmd.locationId}::uuid, ${cmd.poolId}::uuid, ${cmd.storeId}::uuid,
          ${cmd.mode}, ${cmd.quantity}::int, ${cmd.reason}, ${cmd.idempotencyKey},
          ${cmd.expectedVersion ?? null}::bigint, ${cmd.sourceVersion ?? null}::bigint,
          ${cmd.actorType}, ${cmd.actorId}, ${iso(cmd.nowMs)}::timestamptz) as result`.execute(trx);
      return r.rows[0]?.result;
    });
    const res = SyncResult.parse(raw);
    switch (res.status) {
      case "applied":
        return {
          status: "applied",
          replayed: res.replayed,
          oversoldUnits: res.oversold_units,
          level: {
            skuId: cmd.skuId,
            onHand: res.on_hand,
            committed: res.committed,
            reserved: res.reserved,
            available: res.available,
            syncVersion: res.sync_version,
            updatedAtMs: Date.parse(res.updated_at),
          },
        };
      case "stale":
        return { status: "stale", currentSourceVersion: res.current_source_version };
      case "version_conflict":
        return { status: "version_conflict", currentVersion: res.current_version };
      case "negative":
        return { status: "negative", wouldBe: res.would_be };
    }
  }

  async transfer(cmd: TransferCommand): Promise<TransferOutcome> {
    const raw = await this.tx(async (trx) => {
      const r = await sql<{ result: unknown }>`
        select inventory_pool_transfer(
          ${cmd.skuId}::uuid, ${cmd.locationId}::uuid, ${cmd.fromPoolId}::uuid, ${cmd.toPoolId}::uuid,
          ${cmd.storeId}::uuid, ${cmd.qty}::int, ${cmd.idempotencyKey}, ${iso(cmd.nowMs)}::timestamptz) as result`.execute(trx);
      return r.rows[0]?.result;
    });
    const res = TransferResult.parse(raw);
    if (res.status === "transferred") return { status: "transferred", replayed: res.replayed };
    if (res.status === "insufficient") return { status: "insufficient", free: res.free };
    return { status: "invalid" };
  }

  async levelView(skuId: string, locationId: string, poolId: string): Promise<LevelView | null> {
    const raw = await this.tx(async (trx) => {
      const r = await sql<unknown>`
        select l.on_hand, l.committed, l.sync_version,
               extract(epoch from l.updated_at) * 1000 as updated_ms,
               (select count(*)::int from inventory_units u
                 where u.sku_id = l.sku_id and u.location_id = l.location_id and u.pool_id = l.pool_id
                   and u.state = 'RESERVED') as reserved
          from inventory_levels l
         where l.sku_id = ${skuId}::uuid and l.location_id = ${locationId}::uuid and l.pool_id = ${poolId}::uuid`.execute(trx);
      return r.rows[0];
    });
    if (raw === undefined) return null;
    const row = z
      .object({
        on_hand: z.number().int(),
        committed: z.number().int(),
        sync_version: z.coerce.number().int(),
        updated_ms: z.coerce.number(),
        reserved: z.number().int(),
      })
      .parse(raw);
    return {
      skuId,
      onHand: row.on_hand,
      committed: row.committed,
      reserved: row.reserved,
      available: Math.max(0, row.on_hand - row.committed - row.reserved),
      syncVersion: row.sync_version,
      updatedAtMs: Math.round(row.updated_ms),
    };
  }
}

/**
 * Directory that knows only SKUs which already have a stock level. First-time stock for a SKU
 * needs the catalog module's ownership data (SkuDirectory port): this adapter cannot answer that
 * and returns null, which the API reports as 404.
 */
export class LevelBackedSkuDirectory implements SkuDirectory {
  constructor(private readonly db: InventoryDb) {}

  async lookup(skuId: string): Promise<SkuLocation | null> {
    const rows = await this.db.transaction().execute(async (trx) => {
      await sql`select set_config('app.role', 'system', true)`.execute(trx);
      const r = await sql<unknown>`
        select l.store_id::text as store_id, l.location_id::text as location_id,
               (select p.drop_id::text from inventory_levels dl join stock_pools p on p.id = dl.pool_id
                 where dl.sku_id = l.sku_id and p.kind = 'DROP' limit 1) as drop_id
          from inventory_levels l where l.sku_id = ${skuId}::uuid
         order by l.pool_id limit 1`.execute(trx);
      return r.rows;
    });
    const raw = rows[0];
    if (raw === undefined) return null;
    const row = z.object({ store_id: z.string(), location_id: z.string(), drop_id: z.string().nullable() }).parse(raw);
    return { storeId: row.store_id, locationId: row.location_id, dropId: row.drop_id };
  }
}

