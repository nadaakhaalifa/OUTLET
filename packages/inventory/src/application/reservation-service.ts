import { narrowContext, withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { z } from "zod";
import { InventoryError, notFound, validation } from "../domain/errors.js";
import { reservationTransition } from "../domain/state.js";
import type { ReservationState } from "../domain/state.js";
import { inStoreContext } from "./binding.js";
import { makeEnv } from "./env.js";
import type { Env, InventoryDeps } from "./env.js";
import { RESERVE_PICK_SQL, replenishIn } from "./pool.js";

const uuid = z.uuid();
const itemSchema = z.strictObject({ skuId: uuid, locationId: uuid, storeId: uuid, qty: z.number().int().min(1).max(100) });
const reserveSchema = z.strictObject({
  reservationId: uuid.optional(),
  orderGroupRef: z.string().trim().min(1).max(200),
  userId: uuid,
  items: z.array(itemSchema).min(1).max(50),
  /** Seconds; default 600 (card). Wallet 1800, Fawry 86400 come from market config. */
  ttlSec: z.number().int().min(30).max(86_400).default(600),
  ttlPolicy: z.enum(["card", "wallet", "fawry", "cod"]).default("card"),
});
export type ReserveInput = z.input<typeof reserveSchema>;
export type ReserveItem = z.infer<typeof itemSchema>;

export interface Shortfall { readonly skuId: string; readonly locationId: string; readonly requested: number; readonly available: number }
export type ReserveResult =
  | { readonly ok: true; readonly reservationId: string; readonly expiresAt: string; readonly replayed: boolean }
  | { readonly ok: false; readonly shortfalls: readonly Shortfall[] };

export type ClaimResult =
  | { readonly outcome: "claimed" | "already_claimed" | "late_claimed"; readonly reservationId: string; readonly soldOut: readonly { skuId: string; locationId: string }[] }
  /** Late payment and the stock is gone: the caller refunds automatically and apologises (ADR-0005). */
  | { readonly outcome: "unavailable"; readonly reservationId: string; readonly shortfalls: readonly Shortfall[] };

export interface SweepResult {
  readonly expired: readonly string[];
  readonly skipped: number;
  /** Reservations whose release threw: rolled back to their savepoint, left ACTIVE and in the index for the next sweep. */
  readonly failed: readonly string[];
}

interface ReservationRow { id: string; state: ReservationState; expires_at: string | Date; store_ids: string[]; order_group_ref: string; user_id: string }
interface LineRow { sku_id: string; location_id: string; qty: number }

const merge = (items: readonly ReserveItem[]): ReserveItem[] => {
  const m = new Map<string, ReserveItem>();
  for (const it of items) {
    const k = `${it.skuId}|${it.locationId}`;
    const prev = m.get(k);
    if (prev && prev.storeId !== it.storeId) throw validation("one SKU and location cannot belong to two stores");
    m.set(k, prev ? { ...prev, qty: prev.qty + it.qty } : it);
  }
  // Consistent lock order across all concurrent reservations: no deadlocks (ADR-0005).
  return [...m.values()].sort((a, b) => (a.skuId < b.skuId ? -1 : a.skuId > b.skuId ? 1 : a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0));
};

export class ReservationService {
  private readonly env: Env;
  constructor(deps: InventoryDeps) {
    this.env = makeEnv(deps);
  }

  /** Own transaction: user context, statement_timeout 2 s (checkout.reserve pool), one reservation per order group. */
  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const i = this.parse(input);
    return withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId, userId: i.userId }, async (tx) => {
      await tx.query("SELECT set_config('statement_timeout', '2000', true)");
      return this.reserveIn(tx, i);
    });
  }

  /**
   * Reserve inside a caller transaction bound to the shopper's user context. A shortfall rolls back to a savepoint (the
   * whole multi-SKU reservation, no partial holds) and is returned, so the caller's transaction stays usable.
   */
  async reserveIn(tx: Queryable, input: ReserveInput): Promise<ReserveResult> {
    const env = this.env;
    const i = this.parse(input);
    const items = merge(i.items);
    const prior = (await tx.query<ReservationRow>("SELECT id, state, expires_at, store_ids, order_group_ref, user_id FROM reservations WHERE market_id = $1 AND order_group_ref = $2", [env.marketId, i.orderGroupRef])).rows[0];
    if (prior) {
      if (prior.state !== "ACTIVE") throw new InventoryError("conflict", `order group already has a ${prior.state} reservation`);
      if (prior.user_id !== i.userId || !(await this.sameItems(tx, prior, items))) throw new InventoryError("conflict", "order group already has a reservation with different items");
      return { ok: true, reservationId: prior.id, expiresAt: new Date(prior.expires_at).toISOString(), replayed: true };
    }
    const id = i.reservationId ?? env.newId();
    const expiresAt = new Date(env.now().getTime() + i.ttlSec * 1000).toISOString();
    const stores = [...new Set(items.map((x) => x.storeId))].sort();
    await tx.query("SAVEPOINT inv_reserve");
    await tx.query(
      `INSERT INTO reservations (id, market_id, user_id, order_group_ref, ttl_policy, expires_at, store_ids, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, env.marketId, i.userId, i.orderGroupRef, i.ttlPolicy, expiresAt, stores, env.now().toISOString()],
    );
    const shortfalls: Shortfall[] = [];
    for (const it of items) {
      const got = await inStoreContext(env, tx, it.storeId, async () => {
        await tx.query("INSERT INTO reservation_lines (reservation_id, sku_id, location_id, store_id, market_id, qty) VALUES ($1,$2,$3,$4,$5,$6)", [id, it.skuId, it.locationId, it.storeId, env.marketId, it.qty]);
        let n = (await tx.query(RESERVE_PICK_SQL, [it.skuId, it.locationId, it.qty, id, expiresAt])).rows.length;
        if (n < it.qty) {
          // Hot SKU with a drained pool: one inline replenisher under the advisory lock, then take the remainder.
          const rep = await replenishIn(env, tx, it.skuId, it.locationId);
          if (rep && rep.added > 0) n += (await tx.query(RESERVE_PICK_SQL, [it.skuId, it.locationId, it.qty - n, id, expiresAt])).rows.length;
        }
        return n;
      });
      if (got < it.qty) shortfalls.push({ skuId: it.skuId, locationId: it.locationId, requested: it.qty, available: got });
    }
    if (shortfalls.length > 0) {
      await tx.query("ROLLBACK TO SAVEPOINT inv_reserve");
      await tx.query("RELEASE SAVEPOINT inv_reserve");
      return { ok: false, shortfalls };
    }
    await tx.query("INSERT INTO inventory_expiry_index (reservation_id, market_id, store_refs, owner_ref, expires_at) VALUES ($1,$2,$3,$4,$5)", [id, env.marketId, stores, i.userId, expiresAt]);
    await tx.query("RELEASE SAVEPOINT inv_reserve");
    return { ok: true, reservationId: id, expiresAt, replayed: false };
  }

  /** Does the stored reservation hold exactly these (merged) items? Lines are store-owned, so read per store context. */
  private async sameItems(tx: Queryable, prior: ReservationRow, items: readonly ReserveItem[]): Promise<boolean> {
    const have = new Map<string, number>();
    for (const storeId of prior.store_ids) {
      await inStoreContext(this.env, tx, storeId, async () => {
        for (const l of (await tx.query<LineRow>("SELECT sku_id, location_id, qty FROM reservation_lines WHERE reservation_id = $1", [prior.id])).rows) have.set(`${l.sku_id}|${l.location_id}`, l.qty);
      });
    }
    return have.size === items.length && items.every((x) => have.get(`${x.skuId}|${x.locationId}`) === x.qty);
  }

  /** Own transaction (user context of the order owner). */
  async claim(userId: string, reservationId: string): Promise<ClaimResult> {
    const r = await withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId, userId: uuid.parse(userId) }, (tx) => this.claimIn(tx, reservationId));
    await this.publish(r);
    return r;
  }

  /**
   * Claim on payment.succeeded / COD confirmation, inside the CALLER's transaction (bound to the owner's user context) so the
   * ledger posting commits atomically with it. Idempotent. Units -> claimed, committed += qty, outbox event inventory.claimed.
   * An expired reservation is auto-claimed from the pool if stock is still there, else `unavailable` (caller refunds).
   * The caller applies `publish(result)` after commit.
   */
  async claimIn(tx: Queryable, reservationId: string): Promise<ClaimResult> {
    const env = this.env;
    const res = await this.lock(tx, reservationId);
    if (res.state === "CLAIMED") return { outcome: "already_claimed", reservationId, soldOut: [] };
    const late = res.state === "EXPIRED";
    const next = reservationTransition(res.state, late ? "late_claim" : "claim");
    const now = env.now();
    const expiresAt = new Date(now.getTime() + 60_000).toISOString();
    await tx.query("SAVEPOINT inv_claim");
    const shortfalls: Shortfall[] = [];
    const soldOut: { skuId: string; locationId: string }[] = [];
    const lines: { sku_id: string; location_id: string; qty: number }[] = [];
    for (const storeId of res.store_ids) {
      await inStoreContext(env, tx, storeId, async () => {
        const ls = (await tx.query<LineRow>("SELECT sku_id, location_id, qty FROM reservation_lines WHERE reservation_id = $1 ORDER BY sku_id, location_id", [reservationId])).rows;
        for (const l of ls) {
          if (late) {
            const have = (await tx.query("SELECT 1 FROM inventory_units WHERE sku_id = $1 AND location_id = $2 AND reservation_id = $3 AND state = 'reserved'", [l.sku_id, l.location_id, reservationId])).rows.length;
            if (have < l.qty) await tx.query(RESERVE_PICK_SQL, [l.sku_id, l.location_id, l.qty - have, reservationId, expiresAt]);
          }
          const claimed = (await tx.query("UPDATE inventory_units SET state = 'claimed', expires_at = NULL WHERE sku_id = $1 AND location_id = $2 AND reservation_id = $3 AND state = 'reserved' RETURNING id", [l.sku_id, l.location_id, reservationId])).rows.length;
          if (claimed < l.qty) {
            shortfalls.push({ skuId: l.sku_id, locationId: l.location_id, requested: l.qty, available: claimed });
            continue;
          }
          const lv = (
            await tx.query<{ on_hand: number; committed: number }>(
              `UPDATE inventory_levels SET committed = committed + $3, version = version + 1, updated_at = $4::timestamptz
                WHERE sku_id = $1 AND location_id = $2 RETURNING on_hand, committed`,
              [l.sku_id, l.location_id, l.qty, now.toISOString()],
            )
          ).rows[0];
          lines.push(l);
          if (lv && lv.on_hand - lv.committed <= 0) soldOut.push({ skuId: l.sku_id, locationId: l.location_id });
        }
      });
    }
    if (shortfalls.length > 0) {
      await tx.query("ROLLBACK TO SAVEPOINT inv_claim");
      await tx.query("RELEASE SAVEPOINT inv_claim");
      return { outcome: "unavailable", reservationId, shortfalls };
    }
    await tx.query("UPDATE reservations SET state = $2, claimed_at = $3::timestamptz WHERE id = $1", [reservationId, next, now.toISOString()]);
    await tx.query("DELETE FROM inventory_expiry_index WHERE reservation_id = $1", [reservationId]);
    await env.outbox.append(tx, {
      id: env.newId(), type: "inventory.claimed", aggregateType: "reservation", aggregateId: reservationId, marketId: env.marketId, occurredAt: now.toISOString(), visibility: "internal",
      payload: { reservation_id: reservationId, order_group_ref: res.order_group_ref, late, lines: lines.map((l) => ({ sku_id: l.sku_id, location_id: l.location_id, qty: l.qty })) },
    });
    await tx.query("RELEASE SAVEPOINT inv_claim");
    return { outcome: late ? "late_claimed" : "claimed", reservationId, soldOut };
  }

  /** Pushes "definitely sold out" hints after the claiming transaction committed. Write-only: never read as truth. */
  async publish(r: ClaimResult): Promise<void> {
    if (r.outcome === "unavailable") return;
    for (const s of r.soldOut) await this.env.soldOut.set(s.skuId, s.locationId);
  }

  /** Explicit release (checkout cancelled or payment failed). Idempotent for RELEASED / EXPIRED; a CLAIMED reservation cannot be released. */
  async release(userId: string, reservationId: string): Promise<{ state: ReservationState }> {
    return withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId, userId: uuid.parse(userId) }, async (tx) => {
      const res = await this.lock(tx, reservationId);
      if (res.state === "RELEASED" || res.state === "EXPIRED") return { state: res.state };
      const next = reservationTransition(res.state, "release");
      await this.freeUnits(tx, res, next);
      return { state: next };
    });
  }

  /**
   * Returns expired reservations to the pool, oldest first, in SKIP LOCKED batches (default 500 reservations per call).
   * Run every 30 s by the worker (or pg_cron where available, V37). Each reservation is released under its owner's and its
   * stores' contexts; nothing here needs an RLS exception.
   */
  async sweepExpired(now: Date = this.env.now(), batch = 500): Promise<SweepResult> {
    const env = this.env;
    if (!Number.isInteger(batch) || batch < 1 || batch > 5000) throw validation("batch must be 1..5000");
    return withDbContext(env.client, { kind: "user", marketId: env.marketId }, async (tx) => {
      const due = (
        await tx.query<{ reservation_id: string; owner_ref: string }>(
          `SELECT reservation_id, owner_ref FROM inventory_expiry_index WHERE market_id = $1 AND expires_at <= $2::timestamptz
            ORDER BY expires_at LIMIT $3::int FOR UPDATE SKIP LOCKED`,
          [env.marketId, now.toISOString(), batch],
        )
      ).rows;
      const expired: string[] = [];
      const failed: string[] = [];
      let skipped = 0;
      for (const d of due) {
        // One savepoint per reservation: a failure rolls back only that reservation, never the batch.
        await tx.query("SAVEPOINT inv_sweep");
        try {
          await narrowContext(tx, { userId: d.owner_ref });
          const res = (await tx.query<ReservationRow>("SELECT id, state, expires_at, store_ids, order_group_ref, user_id FROM reservations WHERE id = $1 FOR UPDATE SKIP LOCKED", [d.reservation_id])).rows[0];
          if (res?.state !== "ACTIVE") {
            // claimed / released concurrently (or locked by a claim in flight): that path deletes the index row itself
            skipped += 1;
          } else {
            await this.freeUnits(tx, res, reservationTransition("ACTIVE", "expire"));
            expired.push(res.id);
          }
          await tx.query("RELEASE SAVEPOINT inv_sweep");
        } catch {
          await tx.query("ROLLBACK TO SAVEPOINT inv_sweep");
          await tx.query("RELEASE SAVEPOINT inv_sweep");
          failed.push(d.reservation_id);
        }
      }
      return { expired, skipped, failed };
    });
  }

  private async lock(tx: Queryable, reservationId: string): Promise<ReservationRow> {
    uuid.parse(reservationId);
    const res = (await tx.query<ReservationRow>("SELECT id, state, expires_at, store_ids, order_group_ref, user_id FROM reservations WHERE id = $1 FOR UPDATE", [reservationId])).rows[0];
    if (!res) throw notFound("reservation");
    return res;
  }

  private async freeUnits(tx: Queryable, res: ReservationRow, next: ReservationState): Promise<void> {
    for (const storeId of res.store_ids) {
      await inStoreContext(this.env, tx, storeId, async () => {
        const freed = await tx.query<{ sku_id: string; location_id: string }>(
          "UPDATE inventory_units SET state = 'available', reservation_id = NULL, expires_at = NULL WHERE reservation_id = $1 AND state = 'reserved' RETURNING sku_id, location_id",
          [res.id],
        );
        // Released units re-enter the available pool: trim back to the cap (sorted, so advisory locks are taken in one order).
        const keys = [...new Set(freed.rows.map((r) => `${r.sku_id}|${r.location_id}`))].sort();
        for (const k of keys) {
          const [sku = "", loc = ""] = k.split("|");
          await replenishIn(this.env, tx, sku, loc);
        }
      });
    }
    await tx.query("UPDATE reservations SET state = $2, released_at = $3::timestamptz WHERE id = $1", [res.id, next, this.env.now().toISOString()]);
    await tx.query("DELETE FROM inventory_expiry_index WHERE reservation_id = $1", [res.id]);
  }

  private parse(input: ReserveInput): z.output<typeof reserveSchema> {
    const p = reserveSchema.safeParse(input);
    if (!p.success) throw validation("invalid reservation", p.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`));
    return p.data;
  }
}
