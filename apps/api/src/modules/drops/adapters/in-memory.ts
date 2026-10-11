import type { Drop } from "../domain/bridge";
import {
  ACTIVE_STATES,
  type DropInventoryPort,
  type DropOutboxEvent,
  type DropStore,
  type KeysetPosition,
  type PurchaseRecord,
  type SaveResult,
  type SoldOutFlagPort,
  type SocialSignalsPort,
  type SwitchKey,
  type SwitchPort,
  type UnitsSnapshot,
} from "../domain/ports";

const byStartDesc = (a: Drop, b: Drop): number => b.startsAtMs - a.startsAtMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
const afterPos = (p: KeysetPosition | null) => (d: Drop): boolean =>
  p === null || d.startsAtMs < p.startsAtMs || (d.startsAtMs === p.startsAtMs && d.id < p.id);

export class InMemoryDropStore implements DropStore {
  readonly drops = new Map<string, Drop>();
  readonly events: DropOutboxEvent[] = [];
  private readonly waitlist = new Map<string, Set<string>>();
  private readonly purchases = new Map<string, PurchaseRecord & { releasedAtMs: number | null }>();

  async insert(d: Drop, events: readonly DropOutboxEvent[]): Promise<void> {
    this.drops.set(d.id, d);
    this.events.push(...events);
  }
  async get(id: string): Promise<Drop | null> {
    return this.drops.get(id) ?? null;
  }
  async save(next: Drop, expectedVersion: number, events: readonly DropOutboxEvent[]): Promise<SaveResult> {
    const cur = this.drops.get(next.id);
    if (cur === undefined) return "not_found";
    if (cur.version !== expectedVersion) return "conflict";
    this.drops.set(next.id, { ...next, version: expectedVersion + 1 });
    this.events.push(...events);
    return "ok";
  }
  async removeDraft(id: string): Promise<boolean> {
    const d = this.drops.get(id);
    if (d === undefined || d.state !== "DRAFT") return false;
    this.drops.delete(id);
    return true;
  }
  async listPublic(after: KeysetPosition | null, limit: number): Promise<readonly Drop[]> {
    return [...this.drops.values()].filter((d) => d.state !== "DRAFT" && d.state !== "ARCHIVED").sort(byStartDesc).filter(afterPos(after)).slice(0, limit);
  }
  async listByStores(storeIds: readonly string[], after: KeysetPosition | null, limit: number): Promise<readonly Drop[]> {
    return [...this.drops.values()].filter((d) => storeIds.includes(d.storeId)).sort(byStartDesc).filter(afterPos(after)).slice(0, limit);
  }
  async active(): Promise<readonly Drop[]> {
    return [...this.drops.values()].filter((d) => ACTIVE_STATES.includes(d.state));
  }
  async addWaitlist(dropId: string, userId: string, _nowMs: number, events: readonly DropOutboxEvent[]): Promise<"added" | "exists"> {
    const s = this.waitlist.get(dropId) ?? new Set<string>();
    this.waitlist.set(dropId, s);
    if (s.has(userId)) return "exists";
    s.add(userId);
    this.events.push(...events);
    return "added";
  }
  async waitlistSize(dropId: string): Promise<number> {
    return this.waitlist.get(dropId)?.size ?? 0;
  }
  async purchased(dropId: string, skuId: string, userId: string, deviceHash: string) {
    let byUser = 0;
    let byDevice = 0;
    for (const p of this.purchases.values()) {
      if (p.releasedAtMs !== null || p.dropId !== dropId || p.skuId !== skuId) continue;
      if (p.userId === userId) byUser += p.qty;
      if (p.deviceHash === deviceHash) byDevice += p.qty;
    }
    return { byUser, byDevice };
  }
  async recordPurchase(p: PurchaseRecord, events: readonly DropOutboxEvent[]): Promise<"recorded" | "exists"> {
    if (this.purchases.has(p.reservationId)) return "exists";
    this.purchases.set(p.reservationId, { ...p, releasedAtMs: null });
    this.events.push(...events);
    return "recorded";
  }
  async releasePurchase(reservationId: string, nowMs: number): Promise<PurchaseRecord | null> {
    const p = this.purchases.get(reservationId);
    if (p === undefined || p.releasedAtMs !== null) return null;
    this.purchases.set(reservationId, { ...p, releasedAtMs: nowMs });
    return p;
  }
  async boughtSince(dropId: string, sinceMs: number): Promise<number> {
    let n = 0;
    for (const p of this.purchases.values()) if (p.dropId === dropId && p.releasedAtMs === null && p.createdAtMs >= sinceMs) n += p.qty;
    return n;
  }
}

interface Pool {
  cap: number;
  claimed: number;
  reserved: Map<string, { qty: number; expiresAtMs: number }>;
  closed: boolean;
}

/**
 * Fake of the row-per-unit inventory pool (ADR-0005): a single critical section per call, which
 * is what SKIP LOCKED gives the real adapter. Used by the load simulation and the HTTP tests.
 */
export class InMemoryDropInventory implements DropInventoryPort {
  private readonly pools = new Map<string, Pool>();
  private readonly owner = new Map<string, string>();
  readonly claimedLog: string[] = [];
  private key = (d: string, s: string): string => `${d}:${s}`;
  private pool(d: string, s: string): Pool {
    const k = this.key(d, s);
    let p = this.pools.get(k);
    if (p === undefined) {
      p = { cap: 0, claimed: 0, reserved: new Map(), closed: false };
      this.pools.set(k, p);
    }
    return p;
  }
  private reservedQty(p: Pool): number {
    let n = 0;
    for (const r of p.reserved.values()) n += r.qty;
    return n;
  }
  async setCap(dropId: string, skuId: string, cap: number): Promise<void> {
    this.pool(dropId, skuId).cap = cap;
  }
  async reserve(i: { dropId: string; skuId: string; qty: number; reservationId: string; expiresAtMs: number }) {
    const p = this.pool(i.dropId, i.skuId);
    if (p.reserved.has(i.reservationId)) return { ok: true as const };
    const available = p.closed ? 0 : p.cap - p.claimed - this.reservedQty(p);
    if (i.qty < 1 || available < i.qty) return { ok: false as const, available: Math.max(0, available) };
    p.reserved.set(i.reservationId, { qty: i.qty, expiresAtMs: i.expiresAtMs });
    this.owner.set(i.reservationId, this.key(i.dropId, i.skuId));
    return { ok: true as const };
  }
  async release(reservationId: string): Promise<void> {
    const k = this.owner.get(reservationId);
    if (k === undefined) return;
    this.pools.get(k)?.reserved.delete(reservationId);
  }
  async claim(reservationId: string): Promise<boolean> {
    const k = this.owner.get(reservationId);
    const p = k === undefined ? undefined : this.pools.get(k);
    const r = p?.reserved.get(reservationId);
    if (p === undefined || r === undefined) return false;
    p.reserved.delete(reservationId);
    p.claimed += r.qty;
    this.claimedLog.push(reservationId);
    return true;
  }
  async snapshot(dropId: string, skuId: string): Promise<UnitsSnapshot> {
    const p = this.pool(dropId, skuId);
    const reserved = this.reservedQty(p);
    return { cap: p.cap, claimed: p.claimed, reserved, available: p.closed ? 0 : Math.max(0, p.cap - p.claimed - reserved) };
  }
  async sweepExpired(nowMs: number): Promise<readonly string[]> {
    const out: string[] = [];
    for (const p of this.pools.values()) {
      for (const [id, r] of p.reserved) {
        if (r.expiresAtMs <= nowMs) {
          p.reserved.delete(id);
          out.push(id);
        }
      }
    }
    return out;
  }
  async closeDrop(dropId: string): Promise<void> {
    for (const [k, p] of this.pools) if (k.startsWith(`${dropId}:`)) p.closed = true;
  }
}

export class InMemorySoldOutFlags implements SoldOutFlagPort {
  private readonly until = new Map<string, number>();
  constructor(private readonly nowMs: () => number) {}
  async mark(dropId: string, ttlMs: number): Promise<void> {
    this.until.set(dropId, this.nowMs() + ttlMs);
  }
  async clear(dropId: string): Promise<void> {
    this.until.delete(dropId);
  }
  async isSoldOut(dropId: string): Promise<boolean> {
    return (this.until.get(dropId) ?? 0) > this.nowMs();
  }
}

export class FakeSocialSignals implements SocialSignalsPort {
  private readonly viewing = new Map<string, number>();
  set(dropId: string, n: number | null): void {
    if (n === null) this.viewing.delete(dropId);
    else this.viewing.set(dropId, n);
  }
  async viewingNow(dropId: string): Promise<number | null> {
    return this.viewing.get(dropId) ?? null;
  }
}

export class FakeDropSwitches implements SwitchPort {
  private readonly off = new Set<SwitchKey>();
  kill(k: SwitchKey): void {
    this.off.add(k);
  }
  restore(k: SwitchKey): void {
    this.off.delete(k);
  }
  async allowed(k: SwitchKey): Promise<boolean> {
    return !this.off.has(k);
  }
}
