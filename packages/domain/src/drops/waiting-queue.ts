import { HEARTBEAT_TTL_MS } from "./admission";

export type TicketState = "waiting" | "admitted" | "abandoned" | "rejected";

export interface Ticket {
  readonly id: string;
  readonly userId: string;
  readonly deviceHash: string;
  readonly seq: number;
  readonly joinedAtMs: number;
  readonly lastSeenMs: number;
  readonly state: TicketState;
  readonly admittedAtMs: number | null;
}

export type JoinResult =
  | { readonly kind: "joined"; readonly ticket: Ticket }
  /** Same account again: collapses to the earliest ticket. */
  | { readonly kind: "existing"; readonly ticket: Ticket }
  /** Another account already holds this device's single active ticket. */
  | { readonly kind: "device_busy" };

/** Fenwick tree over arrival sequence numbers: O(log n) rank of a waiting ticket. */
class Fenwick {
  private readonly vals: number[] = [];
  private tree: number[] = new Array<number>(1025).fill(0);
  private n = 1024;

  private update(i: number, d: number): void {
    for (let x = i; x <= this.n; x += x & -x) this.tree[x] = (this.tree[x] ?? 0) + d;
  }

  add(seq: number, d: number): void {
    if (seq + 1 > this.n) {
      while (this.n < seq + 1) this.n *= 2;
      this.tree = new Array<number>(this.n + 1).fill(0);
      this.vals.forEach((v, i) => {
        if (v !== 0) this.update(i + 1, v);
      });
    }
    this.vals[seq] = (this.vals[seq] ?? 0) + d;
    this.update(seq + 1, d);
  }

  /** Sum of values with sequence < seq. */
  before(seq: number): number {
    let s = 0;
    for (let x = Math.min(seq, this.n); x > 0; x -= x & -x) s += this.tree[x] ?? 0;
    return s;
  }
}

/**
 * Pure FIFO waiting room (spec 16, §20.2): arrival order, one active ticket per device, an
 * account collapses to its earliest ticket, heartbeat TTL releases a slot. No clocks, no IO:
 * time is always an argument, so every behaviour is reproducible in a property test.
 * Redis (sorted set) implements the same contract behind QueuePort.
 */
export class FifoWaitingQueue {
  private readonly byId = new Map<string, Ticket>();
  private readonly activeByUser = new Map<string, string>();
  private readonly activeByDevice = new Map<string, string>();
  private readonly order: string[] = [];
  private head = 0;
  private nextSeq = 0;
  private readonly rank = new Fenwick();
  private waiting = 0;

  constructor(private readonly heartbeatTtlMs: number = HEARTBEAT_TTL_MS) {}

  get waitingCount(): number {
    return this.waiting;
  }

  join(ticketId: string, userId: string, deviceHash: string, nowMs: number): JoinResult {
    this.lazyExpire(this.activeByUser.get(userId), nowMs);
    this.lazyExpire(this.activeByDevice.get(deviceHash), nowMs);
    const mine = this.activeByUser.get(userId);
    if (mine !== undefined) {
      const t = this.byId.get(mine);
      if (t !== undefined) return { kind: "existing", ticket: this.touch(t, nowMs) };
    }
    if (this.activeByDevice.has(deviceHash)) return { kind: "device_busy" };
    const t: Ticket = {
      id: ticketId,
      userId,
      deviceHash,
      seq: this.nextSeq++,
      joinedAtMs: nowMs,
      lastSeenMs: nowMs,
      state: "waiting",
      admittedAtMs: null,
    };
    this.byId.set(t.id, t);
    this.order.push(t.id);
    this.activeByUser.set(userId, t.id);
    this.activeByDevice.set(deviceHash, t.id);
    this.rank.add(t.seq, 1);
    this.waiting++;
    return { kind: "joined", ticket: t };
  }

  private touch(t: Ticket, nowMs: number): Ticket {
    if (t.state !== "waiting") return t;
    const u = { ...t, lastSeenMs: nowMs };
    this.byId.set(u.id, u);
    return u;
  }

  /** Heartbeat. Returns the ticket as it is now, or null when unknown. */
  heartbeat(userId: string, nowMs: number): Ticket | null {
    this.lazyExpire(this.activeByUser.get(userId), nowMs);
    const id = this.activeByUser.get(userId);
    if (id === undefined) return null;
    const t = this.byId.get(id);
    return t === undefined ? null : this.touch(t, nowMs);
  }

  /** 1-based position among waiting tickets; null when not waiting. */
  position(ticketId: string): number | null {
    const t = this.byId.get(ticketId);
    if (t === undefined || t.state !== "waiting") return null;
    return this.rank.before(t.seq) + 1;
  }

  get(ticketId: string): Ticket | undefined {
    return this.byId.get(ticketId);
  }

  private release(t: Ticket, state: TicketState, nowMs: number): Ticket {
    const u: Ticket = { ...t, state, admittedAtMs: state === "admitted" ? nowMs : t.admittedAtMs };
    this.byId.set(u.id, u);
    if (t.state === "waiting") {
      this.rank.add(t.seq, -1);
      this.waiting--;
    }
    // An admitted ticket keeps the device and the account busy until the token window ends
    // (finish()), so a user cannot re-queue behind their own admission.
    if (state !== "admitted") {
      if (this.activeByUser.get(t.userId) === t.id) this.activeByUser.delete(t.userId);
      if (this.activeByDevice.get(t.deviceHash) === t.id) this.activeByDevice.delete(t.deviceHash);
    }
    return u;
  }

  leave(userId: string, nowMs: number): Ticket | null {
    const id = this.activeByUser.get(userId);
    const t = id === undefined ? undefined : this.byId.get(id);
    if (t === undefined || t.state !== "waiting") return null;
    return this.release(t, "abandoned", nowMs);
  }

  private readonly lazy: Ticket[] = [];

  /** O(1) staleness check of one ticket, used on the hot join/heartbeat paths. */
  private lazyExpire(id: string | undefined, nowMs: number): void {
    const t = id === undefined ? undefined : this.byId.get(id);
    if (t !== undefined && t.state === "waiting" && nowMs - t.lastSeenMs > this.heartbeatTtlMs) {
      this.lazy.push(this.release(t, "abandoned", nowMs));
    }
  }

  /** Drops tickets whose heartbeat is older than the TTL. Returns the abandoned tickets. */
  expire(nowMs: number): readonly Ticket[] {
    const out: Ticket[] = this.lazy.splice(0);
    for (let i = this.head; i < this.order.length; i++) {
      const t = this.byId.get(this.order[i] ?? "");
      if (t !== undefined && t.state === "waiting" && nowMs - t.lastSeenMs > this.heartbeatTtlMs) {
        out.push(this.release(t, "abandoned", nowMs));
      }
    }
    return out;
  }

  /** Admits up to `n` earliest waiting tickets, strictly in arrival order. */
  admit(n: number, nowMs: number): readonly Ticket[] {
    this.expire(nowMs);
    const out: Ticket[] = [];
    while (out.length < n && this.head < this.order.length) {
      const id = this.order[this.head++];
      const t = id === undefined ? undefined : this.byId.get(id);
      if (t === undefined || t.state !== "waiting") continue;
      out.push(this.release(t, "admitted", nowMs));
    }
    return out;
  }

  /** The admission was used or its window ended: the account and device may queue again. */
  finish(ticketId: string): void {
    const t = this.byId.get(ticketId);
    if (t === undefined || t.state !== "admitted") return;
    if (this.activeByUser.get(t.userId) === t.id) this.activeByUser.delete(t.userId);
    if (this.activeByDevice.get(t.deviceHash) === t.id) this.activeByDevice.delete(t.deviceHash);
  }

  /** Rejects a waiting ticket without admitting (e.g. the Plus entitlement lapsed). */
  reject(ticketId: string, nowMs: number): Ticket | null {
    const t = this.byId.get(ticketId);
    if (t === undefined || t.state !== "waiting") return null;
    return this.release(t, "rejected", nowMs);
  }

  waitingTickets(limit: number): readonly Ticket[] {
    const out: Ticket[] = [];
    for (let i = this.head; i < this.order.length && out.length < limit; i++) {
      const t = this.byId.get(this.order[i] ?? "");
      if (t !== undefined && t.state === "waiting") out.push(t);
    }
    return out;
  }
}

/**
 * Rank inversion rate of an admission sequence against arrival order: the fraction of
 * adjacent admitted pairs whose arrival sequence goes backwards. FIFO gives 0 (spec: <= 1%).
 */
export function fifoDeviation(admittedSeqs: readonly number[]): number {
  if (admittedSeqs.length < 2) return 0;
  let inv = 0;
  for (let i = 1; i < admittedSeqs.length; i++) {
    const a = admittedSeqs[i - 1];
    const b = admittedSeqs[i];
    if (a !== undefined && b !== undefined && b < a) inv++;
  }
  return inv / (admittedSeqs.length - 1);
}
