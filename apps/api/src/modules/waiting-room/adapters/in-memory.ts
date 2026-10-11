import { FifoWaitingQueue, type JoinResult, type Ticket } from "../domain/bridge";
import {
  QueueUnavailableError,
  type AdmissionRecord,
  type AdmissionStore,
  type AttestationPort,
  type BotScorePort,
  type DropGatePort,
  type EndedTicket,
  type EntitlementPort,
  type GateDrop,
  type QueuePort,
  type SecretPort,
  type SigningKey,
  type SwitchKey,
  type SwitchPort,
  type WaitingRoomEvent,
} from "../domain/ports";

/** In-memory QueuePort: the pure FifoWaitingQueue per drop. `down` simulates Redis being unreachable. */
export class InMemoryQueue implements QueuePort {
  private readonly queues = new Map<string, FifoWaitingQueue>();
  down = false;

  private q(dropId: string): FifoWaitingQueue {
    if (this.down) throw new QueueUnavailableError();
    let q = this.queues.get(dropId);
    if (q === undefined) {
      q = new FifoWaitingQueue();
      this.queues.set(dropId, q);
    }
    return q;
  }
  async join(dropId: string, ticketId: string, userId: string, deviceHash: string, nowMs: number): Promise<JoinResult> {
    return this.q(dropId).join(ticketId, userId, deviceHash, nowMs);
  }
  async heartbeat(dropId: string, userId: string, nowMs: number) {
    const q = this.q(dropId);
    const t = q.heartbeat(userId, nowMs);
    return t === null ? null : { ticket: t, position: q.position(t.id) };
  }
  async peek(dropId: string, limit: number): Promise<readonly Ticket[]> {
    return this.q(dropId).waitingTickets(limit);
  }
  async reject(dropId: string, ticketId: string, nowMs: number): Promise<Ticket | null> {
    return this.q(dropId).reject(ticketId, nowMs);
  }
  async admit(dropId: string, n: number, nowMs: number): Promise<readonly Ticket[]> {
    return this.q(dropId).admit(n, nowMs);
  }
  async expire(dropId: string, nowMs: number): Promise<readonly Ticket[]> {
    return this.q(dropId).expire(nowMs);
  }
  async finish(dropId: string, ticketId: string): Promise<void> {
    this.q(dropId).finish(ticketId);
  }
  async size(dropId: string): Promise<number> {
    return this.q(dropId).waitingCount;
  }
}

export class InMemoryAdmissionStore implements AdmissionStore {
  readonly admissions = new Map<string, AdmissionRecord>();
  private readonly latest = new Map<string, string>();
  readonly ended: EndedTicket[] = [];
  readonly events: WaitingRoomEvent[] = [];

  async recordAdmission(rec: AdmissionRecord, events: readonly WaitingRoomEvent[]): Promise<void> {
    if (!this.admissions.has(rec.jti)) {
      this.admissions.set(rec.jti, rec);
      this.latest.set(`${rec.dropId}:${rec.userId}`, rec.jti);
      this.events.push(...events);
    }
  }
  async recordEnded(t: EndedTicket, events: readonly WaitingRoomEvent[]): Promise<void> {
    if (this.ended.some((e) => e.ticketId === t.ticketId)) return;
    this.ended.push(t);
    this.events.push(...events);
  }
  async recordJoined(_dropId: string, _ticketId: string, events: readonly WaitingRoomEvent[]): Promise<void> {
    this.events.push(...events);
  }
  async latestAdmission(dropId: string, userId: string): Promise<AdmissionRecord | null> {
    const jti = this.latest.get(`${dropId}:${userId}`);
    return jti === undefined ? null : (this.admissions.get(jti) ?? null);
  }
  async consume(jti: string, nowMs: number): Promise<"used" | "already_used" | "unknown" | "expired"> {
    const r = this.admissions.get(jti);
    if (r === undefined) return "unknown";
    if (nowMs >= r.expiresAtMs) return "expired";
    if (r.usedAtMs !== null) return "already_used";
    this.admissions.set(jti, { ...r, usedAtMs: nowMs });
    return "used";
  }
}

export class FakeSecrets implements SecretPort {
  private readonly keys = new Map<string, Uint8Array>();
  private currentKid: string;
  constructor(kid = "k1", seed = "test-only-signing-key-0123456789abcdef") {
    this.keys.set(kid, new TextEncoder().encode(seed));
    this.currentKid = kid;
  }
  rotate(kid: string, seed: string): void {
    this.keys.set(kid, new TextEncoder().encode(seed));
    this.currentKid = kid;
  }
  retire(kid: string): void {
    this.keys.delete(kid);
  }
  async current(): Promise<SigningKey> {
    const key = this.keys.get(this.currentKid);
    if (key === undefined) throw new Error("no signing key");
    return { kid: this.currentKid, key };
  }
  async byKid(kid: string): Promise<Uint8Array | null> {
    return this.keys.get(kid) ?? null;
  }
}

export class FakeBotScore implements BotScorePort {
  private readonly scores = new Map<string, number>();
  fail = false;
  defaultScore = 5;
  set(userId: string, score: number): void {
    this.scores.set(userId, score);
  }
  async score(i: { userId: string }): Promise<number> {
    if (this.fail) throw new Error("bot scoring unavailable");
    return this.scores.get(i.userId) ?? this.defaultScore;
  }
}

export class FakeAttestation implements AttestationPort {
  private readonly bad = new Set<string>();
  rejectDevice(deviceId: string): void {
    this.bad.add(deviceId);
  }
  async verify(deviceId: string, token: string | null): Promise<boolean> {
    return token !== null && token.length > 0 && !this.bad.has(deviceId);
  }
}

export class FakeEntitlements implements EntitlementPort {
  private readonly plus = new Set<string>();
  grant(userId: string): void {
    this.plus.add(userId);
  }
  revoke(userId: string): void {
    this.plus.delete(userId);
  }
  async hasEarlyAccess(userId: string): Promise<boolean> {
    return this.plus.has(userId);
  }
}

export class FakeSwitches implements SwitchPort {
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

export class FakeDropGate implements DropGatePort {
  private readonly drops = new Map<string, GateDrop>();
  set(d: GateDrop): void {
    this.drops.set(d.id, d);
  }
  patch(id: string, p: Partial<GateDrop>): void {
    const d = this.drops.get(id);
    if (d !== undefined) this.drops.set(id, { ...d, ...p });
  }
  async get(id: string): Promise<GateDrop | null> {
    return this.drops.get(id) ?? null;
  }
  async activeDropIds(): Promise<readonly string[]> {
    return [...this.drops.values()].filter((d) => ["SCHEDULED", "EARLY_ACCESS", "LIVE"].includes(d.state)).map((d) => d.id);
  }
}
