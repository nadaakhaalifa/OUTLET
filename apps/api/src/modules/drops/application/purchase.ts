import { checkPurchaseLimit, ladderPriceAt, nextState, type Drop } from "../domain/bridge";
import type { DropOutboxEvent } from "../domain/ports";
import { withState, type DropDeps } from "./shared";
import { createHash } from "node:crypto";

export interface ReserveLine {
  readonly skuId: string;
  readonly qty: number;
}

export interface ReserveInput {
  readonly dropId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly admissionToken: string;
  readonly lines: readonly ReserveLine[];
}

export interface ReservedLine {
  readonly reservationId: string;
  readonly skuId: string;
  readonly qty: number;
  readonly unitPricePiastres: bigint;
  readonly expiresAtMs: number;
}

export type ReserveOutcome =
  | { readonly kind: "reserved"; readonly lines: readonly ReservedLine[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "paused" }
  | { readonly kind: "not_open" }
  /** Checkout maps every admission_* outcome to HTTP 403; the user rejoins at the back. */
  | { readonly kind: "admission_expired" }
  | { readonly kind: "admission_invalid"; readonly code: string }
  | { readonly kind: "admission_used" }
  | { readonly kind: "limit_exceeded"; readonly skuId: string; readonly code: "user_limit" | "device_limit" | "bad_quantity"; readonly remaining: number }
  | { readonly kind: "sold_out"; readonly skuId: string; readonly available: number };

const dev = (id: string): string => createHash("sha256").update(id, "utf8").digest("hex");

/** Current server-timed unit price: ladders step down on the published schedule, nothing else moves. */
export const unitPrice = (d: Drop, skuId: string, nowMs: number): bigint | null => {
  const it = d.items.find((i) => i.skuId === skuId);
  if (it === undefined) return null;
  return d.type === "price_ladder" ? ladderPriceAt(d.ladder, it.pricePiastres, nowMs) : it.pricePiastres;
};

/**
 * Reserve drop units behind a valid admission token. Never touches the queue (Redis): the
 * token check is stateless and single use is enforced in Postgres, so a queue outage pauses
 * new admissions without breaking purchases that were already admitted.
 */
export class ReserveDropUnits {
  constructor(private readonly d: DropDeps) {}

  async execute(i: ReserveInput): Promise<ReserveOutcome> {
    const { store, inventory, flags, verifier, switches, clock, ids, cfg } = this.d;
    const drop = await store.get(i.dropId);
    if (drop === null || drop.state === "DRAFT" || drop.state === "ARCHIVED") return { kind: "not_found" };
    if (!(await switches.allowed("drops_all")) || !(await switches.allowed(`drop_type_${drop.type}`))) return { kind: "paused" };
    if (drop.paused) return { kind: "paused" };
    if (drop.state !== "LIVE" && drop.state !== "EARLY_ACCESS") return drop.state === "SOLD_OUT" ? { kind: "sold_out", skuId: "", available: 0 } : { kind: "not_open" };
    if (i.lines.length === 0 || i.lines.some((l) => !drop.items.some((it) => it.skuId === l.skuId))) return { kind: "not_found" };

    const v = await verifier.verify({ token: i.admissionToken, dropId: i.dropId, userId: i.userId, deviceId: i.deviceId });
    if (!v.ok) return v.code === "expired" ? { kind: "admission_expired" } : { kind: "admission_invalid", code: v.code };

    const deviceHash = dev(i.deviceId);
    // Limits count what the user already holds plus what this request asks for per SKU.
    const asked = new Map<string, number>();
    for (const l of i.lines) asked.set(l.skuId, (asked.get(l.skuId) ?? 0) + l.qty);
    for (const [skuId, qty] of asked) {
      const bought = await store.purchased(drop.id, skuId, i.userId, deviceHash);
      const lim = checkPurchaseLimit(drop.limits, bought, qty);
      if (!lim.ok) return { kind: "limit_exceeded", skuId, code: lim.code, remaining: lim.remaining };
    }
    // Pre-filter: a fresh sold-out hint answers without touching the pool. Inventory stays the truth.
    for (const skuId of asked.keys()) {
      if (await flags.isSoldOut(drop.id)) return { kind: "sold_out", skuId, available: 0 };
    }

    const now = clock.nowMs();
    const expiresAtMs = now + cfg.reservationTtlMs;
    const made: ReservedLine[] = [];
    const undo = async (): Promise<void> => {
      for (const m of made) await inventory.release(m.reservationId);
    };
    // SKUs in sorted order: consistent lock ordering (spec 20.2).
    const sorted = [...asked.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [skuId, qty] of sorted) {
      const reservationId = ids.uuidV7();
      const r = await inventory.reserve({ dropId: drop.id, skuId, qty, reservationId, expiresAtMs });
      if (!r.ok) {
        await undo();
        if (r.available === 0) await flags.mark(drop.id, cfg.soldOutHintTtlMs);
        return { kind: "sold_out", skuId, available: r.available };
      }
      const price = unitPrice(drop, skuId, now);
      made.push({ reservationId, skuId, qty, unitPricePiastres: price ?? 0n, expiresAtMs });
    }

    // Single use per drop: the first request to consume the jti wins, the others give the units back.
    const used = await verifier.consume(v.claims.jti);
    if (used !== "used") {
      await undo();
      return used === "expired" ? { kind: "admission_expired" } : { kind: "admission_used" };
    }
    for (const m of made) {
      await store.recordPurchase(
        { reservationId: m.reservationId, dropId: drop.id, skuId: m.skuId, userId: i.userId, deviceHash, qty: m.qty, createdAtMs: now },
        [],
      );
    }
    return { kind: "reserved", lines: made };
  }
}

export class ReleaseDropUnits {
  constructor(private readonly d: DropDeps) {}
  /** Payment failed or the shopper left: units return to the pool, the allowance is freed. */
  async execute(reservationId: string): Promise<"released" | "unknown"> {
    const { store, inventory, flags, clock } = this.d;
    const p = await store.releasePurchase(reservationId, clock.nowMs());
    await inventory.release(reservationId);
    if (p === null) return "unknown";
    await flags.clear(p.dropId);
    return "released";
  }
}

export class ClaimDropUnits {
  constructor(private readonly d: DropDeps) {}
  /** Payment succeeded: units become claimed, and the drop moves to SOLD_OUT when nothing is left unclaimed. */
  async execute(reservationId: string, dropId: string): Promise<"claimed" | "unknown"> {
    const { store, inventory, flags, clock, cfg } = this.d;
    if (!(await inventory.claim(reservationId))) return "unknown";
    const drop = await store.get(dropId);
    if (drop === null) return "claimed";
    let anyLeft = false;
    for (const it of drop.items) {
      const s = await inventory.snapshot(drop.id, it.skuId);
      if (s.cap - s.claimed > 0) anyLeft = true;
    }
    if (!anyLeft && (drop.state === "LIVE" || drop.state === "EARLY_ACCESS")) {
      const next = withState(drop, nextState(drop.state, "STOCK_EXHAUSTED"), clock.nowMs());
      const events: DropOutboxEvent[] = [{ type: "drop.sold_out", dropId: drop.id, storeId: drop.storeId }];
      await store.save(next, drop.version, events);
      await flags.mark(drop.id, cfg.soldOutHintTtlMs * 20);
    }
    return "claimed";
  }
}
