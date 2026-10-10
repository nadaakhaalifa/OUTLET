import { rebalanceDelta, targetPoolRows } from "./pool";
import { planStockSync } from "./sync";
import { expiresAtMs, type ReservePlan } from "./plan";
import {
  levelKey,
  POOL_CAP,
  SWEEP_BATCH,
  type HoldReason,
  type ReservationStatus,
  type Shortfall,
  type StockLine,
  type UnitState,
} from "./types";
import type {
  ClaimOutcome,
  LevelView,
  ReleaseOutcome,
  ReleaseReason,
  ReserveOutcome,
  SweepResult,
  SyncCommand,
  SyncOutcome,
  TransferCommand,
  TransferOutcome,
} from "./outcomes";

/** Domain event destined for the transactional outbox. Payloads carry ids and counts only (P1). */
export interface InventoryEvent {
  readonly type: "inventory.reserved" | "inventory.claimed" | "inventory.released" | "inventory.oversold";
  readonly aggregateId: string;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
  readonly headers: Readonly<Record<string, string | boolean>>;
}

interface Level {
  readonly skuId: string;
  readonly locationId: string;
  readonly poolId: string;
  readonly storeId: string;
  onHand: number;
  committed: number;
  syncVersion: number;
  sourceVersion: number | null;
  updatedAtMs: number;
}

interface Unit {
  readonly id: string;
  readonly key: string;
  state: UnitState;
  reservationId: string | null;
}

interface Reservation {
  readonly id: string;
  readonly orderGroupId: string;
  readonly userId: string;
  status: ReservationStatus;
  readonly holdReason: HoldReason;
  readonly ttlPolicyId: string;
  readonly expiresAtMs: number;
  readonly fingerprint: string;
  readonly lines: readonly StockLine[];
  resolvedAtMs: number | null;
}

export interface ModelDeps {
  /** Unit id generator (uuid in production). Injected so the model stays deterministic. */
  readonly newUnitId: () => string;
  readonly poolCap?: number;
  /** When set, seller `set` is the physical total across pools: the FAWRY on_hand is subtracted (ADV-3). */
  readonly fawryPoolId?: string;
}

/**
 * Reference model of ADR-0005. It defines the semantics that the Postgres functions in migration
 * 0016 implement and that the in-memory adapter uses. It is single-threaded by construction: every
 * method runs to completion, which is the isolation that SKIP LOCKED provides per transaction.
 * It proves the LOGIC (allocation, all-or-nothing, version guards), not Postgres locking behaviour:
 * that is what tooling/db/inventory-concurrency.sh exercises against a real server.
 */
export class StockModel {
  readonly events: InventoryEvent[] = [];
  readonly oversellRecords: { skuId: string; locationId: string; poolId: string; shortfall: number; syncVersion: number }[] = [];
  private readonly levels = new Map<string, Level>();
  private readonly units = new Map<string, Unit>();
  private readonly reservations = new Map<string, Reservation>();
  private readonly byOrderGroup = new Map<string, string>();
  private readonly syncKeys = new Map<string, SyncOutcome>();
  private readonly transferKeys = new Set<string>();
  private readonly cap: number;

  constructor(private readonly deps: ModelDeps) {
    this.cap = deps.poolCap ?? POOL_CAP;
  }

  // ---- reads -----------------------------------------------------------------------------

  private reservedCount(key: string): number {
    let n = 0;
    for (const u of this.units.values()) if (u.key === key && u.state === "RESERVED") n += 1;
    return n;
  }

  private availableIds(key: string): string[] {
    const ids: string[] = [];
    for (const u of this.units.values()) if (u.key === key && u.state === "AVAILABLE") ids.push(u.id);
    return ids.sort();
  }

  availableRows(skuId: string, locationId: string, poolId: string): number {
    return this.availableIds(levelKey(skuId, locationId, poolId)).length;
  }

  level(skuId: string, locationId: string, poolId: string): LevelView | null {
    const key = levelKey(skuId, locationId, poolId);
    const l = this.levels.get(key);
    if (l === undefined) return null;
    const reserved = this.reservedCount(key);
    return {
      skuId,
      onHand: l.onHand,
      committed: l.committed,
      reserved,
      available: Math.max(0, l.onHand - l.committed - reserved),
      syncVersion: l.syncVersion,
      updatedAtMs: l.updatedAtMs,
    };
  }

  reservationStatus(orderGroupId: string): ReservationStatus | null {
    const id = this.byOrderGroup.get(orderGroupId);
    return id === undefined ? null : (this.reservations.get(id)?.status ?? null);
  }

  // ---- pool maintenance --------------------------------------------------------------------

  /** Replenisher and trimmer (spec 20.2): makes AVAILABLE rows equal min(free, cap). */
  rebalance(skuId: string, locationId: string, poolId: string): number {
    return this.rebalanceKey(levelKey(skuId, locationId, poolId));
  }

  private rebalanceKey(key: string): number {
    const l = this.levels.get(key);
    if (l === undefined) return 0;
    const ids = this.availableIds(key);
    const target = targetPoolRows(l.onHand, l.committed, this.reservedCount(key), this.cap);
    const d = rebalanceDelta(target, ids.length);
    for (let i = 0; i < d.insert; i += 1) {
      const id = this.deps.newUnitId();
      this.units.set(id, { id, key, state: "AVAILABLE", reservationId: null });
    }
    // Remove the highest ids: the pick query takes the lowest, so removals avoid hot rows.
    for (const id of ids.slice(ids.length - d.remove)) this.units.delete(id);
    return target;
  }

  // ---- reserve -----------------------------------------------------------------------------

  reserve(cmd: {
    readonly reservationId: string;
    readonly orderGroupId: string;
    readonly userId: string;
    readonly plan: ReservePlan;
    readonly nowMs: number;
  }): ReserveOutcome {
    const existingId = this.byOrderGroup.get(cmd.orderGroupId);
    if (existingId !== undefined) {
      const ex = this.reservations.get(existingId);
      if (ex === undefined) return { status: "conflict" };
      if (ex.fingerprint !== cmd.plan.fingerprint) return { status: "conflict" };
      if (ex.status !== "ACTIVE") return { status: "closed", reservationStatus: ex.status };
      return { status: "reserved", reservationId: ex.id, expiresAtMs: ex.expiresAtMs, replayed: true };
    }
    const shortfalls: Shortfall[] = [];
    for (const line of cmd.plan.lines) {
      const key = levelKey(line.skuId, line.locationId, line.poolId);
      let have = this.availableIds(key).length;
      if (have < line.qty) {
        this.rebalanceKey(key);
        have = this.availableIds(key).length;
      }
      if (have < line.qty) {
        shortfalls.push({ skuId: line.skuId, locationId: line.locationId, requested: line.qty, available: have });
      }
    }
    if (shortfalls.length > 0) return { status: "insufficient", shortfalls };

    const expires = expiresAtMs(cmd.nowMs, cmd.plan.ttlSeconds);
    for (const line of cmd.plan.lines) {
      const key = levelKey(line.skuId, line.locationId, line.poolId);
      for (const id of this.availableIds(key).slice(0, line.qty)) {
        const u = this.units.get(id);
        if (u === undefined) continue;
        u.state = "RESERVED";
        u.reservationId = cmd.reservationId;
      }
      this.events.push({
        type: "inventory.reserved",
        aggregateId: cmd.reservationId,
        payload: { reservation_id: cmd.reservationId, sku_id: line.skuId, quantity: line.qty, expires_at: new Date(expires).toISOString() },
        headers: {},
      });
    }
    this.reservations.set(cmd.reservationId, {
      id: cmd.reservationId,
      orderGroupId: cmd.orderGroupId,
      userId: cmd.userId,
      status: "ACTIVE",
      holdReason: cmd.plan.holdReason,
      ttlPolicyId: cmd.plan.ttlPolicyId,
      expiresAtMs: expires,
      fingerprint: cmd.plan.fingerprint,
      lines: cmd.plan.lines,
      resolvedAtMs: null,
    });
    this.byOrderGroup.set(cmd.orderGroupId, cmd.reservationId);
    return { status: "reserved", reservationId: cmd.reservationId, expiresAtMs: expires, replayed: false };
  }

  // ---- claim -------------------------------------------------------------------------------

  claim(orderGroupId: string, nowMs: number): ClaimOutcome {
    const rid = this.byOrderGroup.get(orderGroupId);
    const r = rid === undefined ? undefined : this.reservations.get(rid);
    if (r === undefined) return { status: "not_found" };
    if (r.status === "CLAIMED") return { status: "already_claimed" };
    if (r.status === "ACTIVE") {
      for (const u of this.units.values()) {
        if (u.reservationId === r.id && u.state === "RESERVED") u.state = "CLAIMED";
      }
      this.commitLines(r, nowMs);
      r.status = "CLAIMED";
      r.resolvedAtMs = nowMs;
      this.emitClaimed(r, false);
      return { status: "claimed" };
    }
    // EXPIRED or RELEASED: attempt a late claim straight from the free pool.
    const shortfalls: Shortfall[] = [];
    for (const line of r.lines) {
      const key = levelKey(line.skuId, line.locationId, line.poolId);
      let have = this.availableIds(key).length;
      if (have < line.qty) {
        this.rebalanceKey(key);
        have = this.availableIds(key).length;
      }
      if (have < line.qty) {
        shortfalls.push({ skuId: line.skuId, locationId: line.locationId, requested: line.qty, available: have });
      }
    }
    if (shortfalls.length > 0) return { status: "unavailable", shortfalls };
    for (const line of r.lines) {
      const key = levelKey(line.skuId, line.locationId, line.poolId);
      for (const id of this.availableIds(key).slice(0, line.qty)) {
        const u = this.units.get(id);
        if (u === undefined) continue;
        u.state = "CLAIMED";
        u.reservationId = r.id;
      }
    }
    this.commitLines(r, nowMs);
    r.status = "CLAIMED";
    r.resolvedAtMs = nowMs;
    this.emitClaimed(r, true);
    return { status: "claimed_late" };
  }

  private commitLines(r: Reservation, nowMs: number): void {
    for (const line of r.lines) {
      const l = this.levels.get(levelKey(line.skuId, line.locationId, line.poolId));
      if (l === undefined) continue;
      l.committed += line.qty;
      l.updatedAtMs = nowMs;
    }
  }

  private emitClaimed(r: Reservation, late: boolean): void {
    for (const line of r.lines) {
      this.events.push({
        type: "inventory.claimed",
        aggregateId: r.id,
        payload: { reservation_id: r.id, sku_id: line.skuId, quantity: line.qty, order_group_id: r.orderGroupId },
        headers: { late },
      });
    }
  }

  // ---- release and expiry -------------------------------------------------------------------

  release(orderGroupId: string, reason: ReleaseReason, nowMs: number): ReleaseOutcome {
    const rid = this.byOrderGroup.get(orderGroupId);
    const r = rid === undefined ? undefined : this.reservations.get(rid);
    if (r === undefined) return { status: "not_found" };
    if (r.status !== "ACTIVE") return { status: "noop", reservationStatus: r.status };
    this.returnUnits(r, "RELEASED", reason, nowMs);
    return { status: "released" };
  }

  private returnUnits(r: Reservation, status: "RELEASED" | "EXPIRED", reason: ReleaseReason, nowMs: number): number {
    let n = 0;
    for (const u of this.units.values()) {
      if (u.reservationId === r.id && u.state === "RESERVED") {
        u.state = "AVAILABLE";
        u.reservationId = null;
        n += 1;
      }
    }
    r.status = status;
    r.resolvedAtMs = nowMs;
    for (const line of r.lines) {
      this.events.push({
        type: "inventory.released",
        aggregateId: r.id,
        payload: { reservation_id: r.id, sku_id: line.skuId, quantity: line.qty, reason },
        headers: {},
      });
    }
    const keys = [...new Set(r.lines.map((l) => levelKey(l.skuId, l.locationId, l.poolId)))].sort();
    for (const k of keys) this.rebalanceKey(k);
    return n;
  }

  sweepExpired(nowMs: number, batch: number = SWEEP_BATCH): SweepResult {
    const due = [...this.reservations.values()]
      .filter((r) => r.status === "ACTIVE" && r.expiresAtMs <= nowMs)
      .sort((a, b) => a.expiresAtMs - b.expiresAtMs || (a.id < b.id ? -1 : 1))
      .slice(0, batch);
    let units = 0;
    for (const r of due) units += this.returnUnits(r, "EXPIRED", "expired", nowMs);
    return { expiredReservations: due.length, releasedUnits: units };
  }

  // ---- seller stock sync --------------------------------------------------------------------

  applySync(cmd: SyncCommand): SyncOutcome {
    const replay = this.syncKeys.get(cmd.idempotencyKey);
    if (replay !== undefined) {
      return replay.status === "applied" ? { ...replay, replayed: true } : replay;
    }
    const key = levelKey(cmd.skuId, cmd.locationId, cmd.poolId);
    const existing = this.levels.get(key);
    const reserved = existing === undefined ? 0 : this.reservedCount(key);
    const fawryId = this.deps.fawryPoolId;
    const fawryOnHand =
      cmd.mode === "set" && fawryId !== undefined && cmd.poolId !== fawryId
        ? (this.levels.get(levelKey(cmd.skuId, cmd.locationId, fawryId))?.onHand ?? 0)
        : 0;
    const setQuantity = cmd.mode === "set" ? Math.max(0, cmd.quantity - fawryOnHand) : cmd.quantity;
    const plan = planStockSync(
      existing === undefined
        ? null
        : {
            onHand: existing.onHand,
            committed: existing.committed,
            reserved,
            syncVersion: existing.syncVersion,
            sourceVersion: existing.sourceVersion,
          },
      { mode: cmd.mode, quantity: setQuantity, expectedVersion: cmd.expectedVersion, sourceVersion: cmd.sourceVersion },
    );
    if (plan.kind === "stale") return { status: "stale", currentSourceVersion: plan.currentSourceVersion };
    if (plan.kind === "version_conflict") return { status: "version_conflict", currentVersion: plan.currentVersion };
    if (plan.kind === "negative") return { status: "negative", wouldBe: plan.wouldBe };

    const l: Level = existing ?? {
      skuId: cmd.skuId,
      locationId: cmd.locationId,
      poolId: cmd.poolId,
      storeId: cmd.storeId,
      onHand: 0,
      committed: 0,
      syncVersion: 0,
      sourceVersion: null,
      updatedAtMs: cmd.nowMs,
    };
    l.onHand = plan.newOnHand;
    l.syncVersion = plan.newSyncVersion;
    if (cmd.sourceVersion !== undefined) l.sourceVersion = cmd.sourceVersion;
    l.updatedAtMs = cmd.nowMs;
    this.levels.set(key, l);
    this.rebalanceKey(key);
    if (plan.oversoldUnits > 0) {
      this.oversellRecords.push({
        skuId: cmd.skuId,
        locationId: cmd.locationId,
        poolId: cmd.poolId,
        shortfall: plan.oversoldUnits,
        syncVersion: l.syncVersion,
      });
      this.events.push({
        type: "inventory.oversold",
        aggregateId: cmd.skuId,
        payload: { sku_id: cmd.skuId, shortfall_units: plan.oversoldUnits },
        headers: {},
      });
    }
    const view = this.level(cmd.skuId, cmd.locationId, cmd.poolId);
    if (view === null) throw new Error("invariant: level missing after sync");
    const outcome: SyncOutcome = { status: "applied", level: view, oversoldUnits: plan.oversoldUnits, replayed: false };
    this.syncKeys.set(cmd.idempotencyKey, outcome);
    return outcome;
  }

  // ---- pool transfer (Fawry allocation) ---------------------------------------------------------

  transferBetweenPools(cmd: TransferCommand): TransferOutcome {
    if (this.transferKeys.has(cmd.idempotencyKey)) return { status: "transferred", replayed: true };
    if (cmd.qty < 1 || cmd.fromPoolId === cmd.toPoolId) return { status: "invalid" };
    const fromKey = levelKey(cmd.skuId, cmd.locationId, cmd.fromPoolId);
    const from = this.levels.get(fromKey);
    if (from === undefined) return { status: "insufficient", free: 0 };
    const free = from.onHand - from.committed - this.reservedCount(fromKey);
    if (free < cmd.qty) return { status: "insufficient", free: Math.max(0, free) };
    const toKey = levelKey(cmd.skuId, cmd.locationId, cmd.toPoolId);
    const to = this.levels.get(toKey) ?? {
      skuId: cmd.skuId,
      locationId: cmd.locationId,
      poolId: cmd.toPoolId,
      storeId: cmd.storeId,
      onHand: 0,
      committed: 0,
      syncVersion: 0,
      sourceVersion: null,
      updatedAtMs: cmd.nowMs,
    };
    from.onHand -= cmd.qty;
    to.onHand += cmd.qty;
    from.updatedAtMs = cmd.nowMs;
    to.updatedAtMs = cmd.nowMs;
    this.levels.set(toKey, to);
    for (const k of [fromKey, toKey].sort()) this.rebalanceKey(k);
    this.transferKeys.add(cmd.idempotencyKey);
    return { status: "transferred", replayed: false };
  }

  // ---- invariants ---------------------------------------------------------------------------

  /** Returns human-readable violations; empty means every invariant of ADR-0005 holds. */
  checkInvariants(options: { readonly allowOversold?: boolean } = {}): string[] {
    const problems: string[] = [];
    for (const [key, l] of this.levels) {
      const counts: Record<UnitState, number> = { AVAILABLE: 0, RESERVED: 0, CLAIMED: 0, WRITTEN_OFF: 0 };
      for (const u of this.units.values()) if (u.key === key) counts[u.state] += 1;
      if (counts.AVAILABLE > this.cap) problems.push(`${key}: pool above cap`);
      if (counts.CLAIMED !== l.committed) problems.push(`${key}: committed ${l.committed} != claimed rows ${counts.CLAIMED}`);
      if (counts.AVAILABLE > Math.max(0, l.onHand - l.committed - counts.RESERVED)) {
        problems.push(`${key}: available rows exceed free stock`);
      }
      if (options.allowOversold !== true && l.committed > l.onHand) problems.push(`${key}: oversold`);
      if (l.onHand < 0 || l.committed < 0) problems.push(`${key}: negative counter`);
    }
    for (const r of this.reservations.values()) {
      const held = [...this.units.values()].filter((u) => u.reservationId === r.id);
      const qty = r.lines.reduce((s, x) => s + x.qty, 0);
      if (r.status === "ACTIVE" && !(held.length === qty && held.every((u) => u.state === "RESERVED"))) {
        problems.push(`reservation ${r.id}: active but units do not match`);
      }
      if (r.status === "CLAIMED" && !(held.length === qty && held.every((u) => u.state === "CLAIMED"))) {
        problems.push(`reservation ${r.id}: claimed but units do not match`);
      }
      if ((r.status === "EXPIRED" || r.status === "RELEASED") && held.length !== 0) {
        problems.push(`reservation ${r.id}: ${r.status} but still holds units`);
      }
    }
    return problems;
  }
}
