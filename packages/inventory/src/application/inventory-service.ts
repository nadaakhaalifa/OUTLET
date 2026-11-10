import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { authorize } from "@outlet/policy";
import type { Action, Principal } from "@outlet/policy";
import { z } from "zod";
import { InventoryError, notFound, validation } from "../domain/errors.js";
import { makeEnv } from "./env.js";
import type { Env, InventoryDeps } from "./env.js";
import { SKU_LOCK_SQL, replenishIn } from "./pool.js";

export const ADJUSTMENT_REASONS = ["seller_edit", "channel_sync", "return_restock", "claim", "write_off", "count", "donation"] as const;

const uuid = z.uuid();
const adjustSchema = z.strictObject({
  skuId: uuid,
  locationId: uuid,
  storeId: uuid,
  delta: z.number().int().refine((n) => n !== 0, "delta must not be zero").refine((n) => Math.abs(n) <= 1_000_000, "delta out of range"),
  idempotencyKey: z.string().trim().min(1).max(200),
  source: z.enum(ADJUSTMENT_REASONS),
  /** Channel sync version: an update that is not newer than the last applied one is ignored (stale). */
  externalVersion: z.number().int().nonnegative().optional(),
});
export type AdjustInput = z.input<typeof adjustSchema>;

export interface AdjustResult {
  readonly applied: boolean;
  readonly replayed: boolean;
  readonly stale: boolean;
  readonly onHand: number;
  readonly committed: number;
  /** Units promised beyond stock after a negative adjustment (0 when none). */
  readonly oversold: number;
}

export interface LevelView {
  readonly onHand: number;
  readonly committed: number;
  readonly poolTarget: number;
  readonly available: number;
  readonly reserved: number;
  readonly claimed: number;
  readonly version: number;
}

interface LevelRow { on_hand: number; committed: number; last_channel_version: string | number | null; version: number }

/** Deny-by-default check through @outlet/policy: a foreign store is not_found, a wrong role is forbidden. */
export const requireAccess = (env: Env, actor: Principal, action: Action, storeId: string): void => {
  if (actor.kind !== "seller_staff" && actor.kind !== "system") throw new InventoryError("forbidden", "forbidden");
  const d = authorize(actor, action, { type: "inventory", storeId, marketId: env.marketId });
  if (d.effect === "deny") throw new InventoryError(d.reason === "not_found" ? "not_found" : "forbidden", d.reason === "not_found" ? "not found" : "forbidden");
};

const asUuid = (v: string | undefined): string | null => (v !== undefined && uuid.safeParse(v).success ? v : null);

export class InventoryService {
  private readonly env: Env;
  constructor(deps: InventoryDeps) {
    this.env = makeEnv(deps);
  }

  private store<T>(storeId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.env.client, { kind: "store", marketId: this.env.marketId, storeId }, fn);
  }

  /** Versioned, idempotent stock edit; fungible pool is reconciled in the same transaction. */
  async adjustOnHand(actor: Principal, input: AdjustInput): Promise<AdjustResult> {
    const i = this.parse(actor, input);
    const out = await this.store(i.storeId, async (tx) => {
      const r = await this.core(tx, actor, i, i.delta);
      if (!r.applied) return { r, free: null };
      const rep = await replenishIn(this.env, tx, i.skuId, i.locationId);
      return { r, free: rep?.free ?? null };
    });
    await this.flag(i.skuId, i.locationId, out.free);
    return out.r;
  }

  /**
   * Registers one serialised one-off unit (ADR-0009): on_hand + 1 and a unit row that carries its defect card and passport
   * link. Idempotent on idempotencyKey. Returns the unit id (the existing one on replay).
   */
  async addSerializedUnit(actor: Principal, input: { skuId: string; locationId: string; storeId: string; defectCardId: string; itemUnitId?: string; idempotencyKey: string }): Promise<{ unitId: string; replayed: boolean }> {
    const i = this.parse(actor, { skuId: input.skuId, locationId: input.locationId, storeId: input.storeId, delta: 1, idempotencyKey: input.idempotencyKey, source: "seller_edit" });
    uuid.parse(input.defectCardId);
    const unitId = this.env.newId();
    const out = await this.store(i.storeId, async (tx) => {
      const r = await this.core(tx, actor, i, 1, "serialised");
      if (r.replayed) {
        const u = await tx.query<{ id: string }>("SELECT id FROM inventory_units WHERE sku_id = $1 AND location_id = $2 AND defect_card_id = $3 ORDER BY id LIMIT 1", [i.skuId, i.locationId, input.defectCardId]);
        return { unitId: u.rows[0]?.id ?? unitId, replayed: true, free: null };
      }
      await tx.query(
        `INSERT INTO inventory_units (sku_id, location_id, id, store_id, market_id, defect_card_id, item_unit_id) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [i.skuId, i.locationId, unitId, i.storeId, this.env.marketId, input.defectCardId, input.itemUnitId ?? null],
      );
      const rep = await replenishIn(this.env, tx, i.skuId, i.locationId);
      return { unitId, replayed: false, free: rep?.free ?? null };
    });
    await this.flag(i.skuId, i.locationId, out.free);
    return { unitId: out.unitId, replayed: out.replayed };
  }

  /** Background top-up for one SKU/location (also called inline by the reserve path when the pool is short). */
  async replenish(storeId: string, skuId: string, locationId: string): Promise<{ added: number; removed: number }> {
    uuid.parse(storeId);
    const r = await this.store(storeId, (tx) => replenishIn(this.env, tx, uuid.parse(skuId), uuid.parse(locationId)));
    if (r === null) throw notFound("inventory level");
    await this.flag(skuId, locationId, r.free);
    return { added: r.added, removed: r.removed };
  }

  /** Replenishes every level of one store. Returns the number of rows added. */
  async replenishStore(storeId: string): Promise<number> {
    uuid.parse(storeId);
    const levels = await this.store(storeId, async (tx) => (await tx.query<{ sku_id: string; location_id: string }>("SELECT sku_id, location_id FROM inventory_levels ORDER BY sku_id, location_id")).rows);
    let added = 0;
    for (const l of levels) added += (await this.replenish(storeId, l.sku_id, l.location_id)).added;
    return added;
  }

  /** Worker entry: store ids come from the non-tenant published read model, each store then runs under its own context. */
  async replenishAll(): Promise<number> {
    const stores = await withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId }, (tx) => tx.query<{ id: string }>("SELECT id FROM catalog_public_stores WHERE market_id = $1 ORDER BY id", [this.env.marketId]));
    let added = 0;
    for (const s of stores.rows) added += await this.replenishStore(s.id);
    return added;
  }

  async getLevel(actor: Principal, storeId: string, skuId: string, locationId: string): Promise<LevelView> {
    uuid.parse(storeId);
    requireAccess(this.env, actor, "listing.read", storeId);
    const r = await this.store(storeId, async (tx) => {
      const l = (await tx.query<{ on_hand: number; committed: number; pool_target: number; version: number }>("SELECT on_hand, committed, pool_target, version FROM inventory_levels WHERE sku_id = $1 AND location_id = $2", [skuId, locationId])).rows[0];
      const c = (
        await tx.query<{ a: number; r: number; c: number }>(
          `SELECT (count(*) FILTER (WHERE state = 'available'))::int AS a, (count(*) FILTER (WHERE state = 'reserved'))::int AS r, (count(*) FILTER (WHERE state = 'claimed'))::int AS c
             FROM inventory_units WHERE sku_id = $1 AND location_id = $2`,
          [skuId, locationId],
        )
      ).rows[0];
      return { l, c };
    });
    if (!r.l) throw notFound("inventory level");
    return { onHand: r.l.on_hand, committed: r.l.committed, poolTarget: r.l.pool_target, version: r.l.version, available: r.c?.a ?? 0, reserved: r.c?.r ?? 0, claimed: r.c?.c ?? 0 };
  }

  private parse(actor: Principal, input: AdjustInput): z.output<typeof adjustSchema> {
    const p = adjustSchema.safeParse(input);
    if (!p.success) throw validation("invalid adjustment", p.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`));
    requireAccess(this.env, actor, "listing.write", p.data.storeId);
    return p.data;
  }

  private async flag(skuId: string, locationId: string, free: number | null): Promise<void> {
    if (free === null) return;
    if (free <= 0) await this.env.soldOut.set(skuId, locationId);
    else await this.env.soldOut.clear(skuId, locationId);
  }

  /** Takes the SKU advisory lock, then locks the level, enforces idempotency and version order, applies the delta, flags oversell. No pool work. */
  private async core(tx: Queryable, actor: Principal, i: z.output<typeof adjustSchema>, delta: number, kind: "fungible" | "serialised" = "fungible"): Promise<AdjustResult> {
    const env = this.env;
    // Lock order: advisory SKU lock first, then the level row (the reserve path and the replenisher take them in this order too).
    await tx.query(SKU_LOCK_SQL, [i.skuId]);
    const select = (): Promise<{ rows: LevelRow[] }> =>
      tx.query<LevelRow>("SELECT on_hand, committed, last_channel_version, version FROM inventory_levels WHERE sku_id = $1 AND location_id = $2 FOR UPDATE", [i.skuId, i.locationId]);
    let lvl = (await select()).rows[0];
    if (!lvl) {
      if (delta < 0) throw notFound("inventory level");
      await tx.query(
        `INSERT INTO inventory_levels (sku_id, location_id, store_id, market_id, updated_at)
         SELECT s.id, l.id, l.store_id, l.market_id, $3::timestamptz FROM inventory_locations l JOIN skus s ON s.store_id = l.store_id
          WHERE l.id = $2 AND s.id = $1 AND l.active ON CONFLICT DO NOTHING`,
        [i.skuId, i.locationId, env.now().toISOString()],
      );
      lvl = (await select()).rows[0];
      if (!lvl) throw notFound("sku or location");
    }
    const view = (applied: boolean, replayed: boolean, stale: boolean, onHand: number, oversold = 0): AdjustResult => ({ applied, replayed, stale, onHand, committed: lvl.committed, oversold });
    const last = lvl.last_channel_version === null ? null : Number(lvl.last_channel_version);
    if (i.source === "channel_sync" && i.externalVersion !== undefined && last !== null && i.externalVersion <= last) return view(false, false, true, lvl.on_hand);

    const actorId = asUuid(actor.userId);
    const ins = await tx.query<{ id: string }>(
      `INSERT INTO inventory_adjustments (id, sku_id, location_id, store_id, market_id, delta, reason, idempotency_key, external_version, actor_type, actor_id, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (store_id, idempotency_key) DO NOTHING RETURNING id`,
      [env.newId(), i.skuId, i.locationId, i.storeId, env.marketId, delta, i.source, i.idempotencyKey, i.externalVersion ?? null, actor.kind, actorId, env.now().toISOString()],
    );
    if (ins.rows.length === 0) {
      const prev = (await tx.query<{ sku_id: string; location_id: string; delta: number }>("SELECT sku_id, location_id, delta FROM inventory_adjustments WHERE idempotency_key = $1", [i.idempotencyKey])).rows[0];
      if (prev?.sku_id !== i.skuId || prev.location_id !== i.locationId || prev.delta !== delta) throw new InventoryError("conflict", "idempotency key reused with a different adjustment");
      return view(false, true, false, lvl.on_hand);
    }
    // A SKU is either fungible (pool rows) or serialised (graded one-off units), never both (also enforced by trigger in 0013).
    if (delta > 0 && kind === "fungible" && (await tx.query("SELECT 1 FROM inventory_units WHERE sku_id = $1 AND defect_card_id IS NOT NULL LIMIT 1", [i.skuId])).rows.length > 0) {
      throw new InventoryError("conflict", "sku holds serialised units: fungible stock cannot be added");
    }
    if (kind === "serialised" && (await tx.query("SELECT 1 FROM inventory_units WHERE sku_id = $1 AND defect_card_id IS NULL LIMIT 1", [i.skuId])).rows.length > 0) {
      throw new InventoryError("conflict", "sku holds fungible units: a serialised unit cannot be added");
    }
    const onHand = lvl.on_hand + delta;
    if (onHand < 0) throw new InventoryError("insufficient_stock", "on_hand cannot go below zero");
    await tx.query(
      `UPDATE inventory_levels SET on_hand = $3, last_channel_version = GREATEST(COALESCE(last_channel_version, 0), COALESCE($4::bigint, 0)), version = version + 1, updated_at = $5::timestamptz
        WHERE sku_id = $1 AND location_id = $2`,
      [i.skuId, i.locationId, onHand, i.externalVersion ?? null, env.now().toISOString()],
    );
    let oversold = 0;
    if (delta < 0) {
      const reserved = (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM inventory_units WHERE sku_id = $1 AND location_id = $2 AND state = 'reserved'", [i.skuId, i.locationId])).rows[0]?.n ?? 0;
      oversold = Math.max(0, lvl.committed + reserved - onHand);
      if (oversold > 0) {
        // Existing reservations and claimed orders are honoured; the seller carries a penalty (ADR-0005, data-model 7.12).
        await env.outbox.append(tx, {
          id: env.newId(), type: "inventory.seller_oversell_penalty", aggregateType: "sku", aggregateId: i.skuId, marketId: env.marketId, occurredAt: env.now().toISOString(), visibility: "internal",
          payload: { store_id: i.storeId, sku_id: i.skuId, location_id: i.locationId, oversold_units: oversold, on_hand: onHand, committed: lvl.committed, reserved_units: reserved, idempotency_key: i.idempotencyKey },
        });
      }
    }
    return view(true, false, false, onHand, oversold);
  }
}
