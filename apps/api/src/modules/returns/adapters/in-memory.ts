/**
 * DEVELOPMENT AND TEST FIXTURES: per-process repository, fakes for the ports owned by other
 * modules. The module refuses to boot with these outside test mode (MissingReturnsPortsError).
 */
import type {
  CreateOutcome,
  EvidencePort,
  ExchangeStockPort,
  MembershipPort,
  Page,
  ReturnEvent,
  ReturnEventPublisher,
  ReturnRecord,
  ReturnRepository,
  ReturnableLine,
  ReturnableLinePort,
  ReturnerHistory,
  ReturnerHistoryPort,
  StandingRecord,
} from "../domain/ports";
import { decodeCursor, encodeCursor } from "../domain/cursor";

const CANCELLED = "CANCELLED";

function newestFirst(a: ReturnRecord, b: ReturnRecord): number {
  return a.createdAtMs !== b.createdAtMs ? b.createdAtMs - a.createdAtMs : a.id < b.id ? 1 : -1;
}

function pageOf(rows: readonly ReturnRecord[], cursor: string | null, limit: number): Page<ReturnRecord> {
  const sorted = [...rows].sort(newestFirst);
  const c = cursor === null ? null : decodeCursor(cursor);
  const after = c === null ? sorted : sorted.filter((r) => r.createdAtMs < c.createdAtMs || (r.createdAtMs === c.createdAtMs && r.id < c.id));
  const items = after.slice(0, limit);
  const more = after.length > limit;
  const last = items[items.length - 1];
  return { items, nextCursor: more && last !== undefined ? encodeCursor({ createdAtMs: last.createdAtMs, id: last.id }) : null };
}

const OPEN_STATES = new Set(["REQUESTED", "PICKUP_SCHEDULED", "IN_TRANSIT", "RECEIVED", "APPROVED", "REJECTED", "DISPUTED"]);

export class InMemoryReturnRepository implements ReturnRepository {
  private readonly byId = new Map<string, ReturnRecord>();
  private readonly standing = new Map<string, StandingRecord>();

  async findById(id: string): Promise<ReturnRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(userId: string, key: string): Promise<ReturnRecord | null> {
    for (const r of this.byId.values()) if (r.userId === userId && r.idempotencyKey === key) return r;
    return null;
  }

  async createIfCapacity(record: ReturnRecord, lineQty: number): Promise<CreateOutcome> {
    const dup = await this.findByIdempotencyKey(record.userId, record.idempotencyKey);
    if (dup !== null) return { kind: "duplicate", record: dup };
    const committed = await this.committedQty(record.orderLineId);
    if (committed !== record.priorQty) return { kind: "conflict" };
    if (committed + record.qty > lineQty) return { kind: "over_capacity" };
    this.byId.set(record.id, record);
    return { kind: "created", record };
  }

  async committedQty(orderLineId: string): Promise<number> {
    let n = 0;
    for (const r of this.byId.values()) if (r.orderLineId === orderLineId && r.state !== CANCELLED) n += r.qty;
    return n;
  }

  async exchangeCount(orderLineId: string): Promise<number> {
    let n = 0;
    for (const r of this.byId.values()) {
      if (r.orderLineId === orderLineId && r.state !== CANCELLED && r.resolution === "exchange") n += 1;
    }
    return n;
  }

  async save(record: ReturnRecord, expectedVersion: number): Promise<boolean> {
    const current = this.byId.get(record.id);
    if (current === undefined || current.version !== expectedVersion) return false;
    this.byId.set(record.id, record);
    return true;
  }

  async listForUser(userId: string, cursor: string | null, limit: number): Promise<Page<ReturnRecord>> {
    return pageOf([...this.byId.values()].filter((r) => r.userId === userId), cursor, limit);
  }

  async listForStores(storeIds: readonly string[], cursor: string | null, limit: number): Promise<Page<ReturnRecord>> {
    return pageOf([...this.byId.values()].filter((r) => storeIds.includes(r.storeId)), cursor, limit);
  }

  async listInspectionOverdue(nowMs: number, limit: number): Promise<readonly ReturnRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.state === "RECEIVED" && r.inspectionDueAtMs !== null && r.inspectionDueAtMs <= nowMs)
      .slice(0, limit);
  }

  async listDisputeWindowElapsed(nowMs: number, limit: number): Promise<readonly ReturnRecord[]> {
    return [...this.byId.values()]
      .filter((r) => r.state === "REJECTED" && r.disputeWindowEndsAtMs !== null && r.disputeWindowEndsAtMs < nowMs)
      .slice(0, limit);
  }

  async listUnpublishedIntents(limit: number): Promise<readonly ReturnRecord[]> {
    return [...this.byId.values()].filter((r) => r.state === "APPROVED" && r.intentPublishedAtMs === null).slice(0, limit);
  }

  async hasOpenReturns(userId: string): Promise<boolean> {
    return [...this.byId.values()].some((r) => r.userId === userId && OPEN_STATES.has(r.state));
  }

  async getStanding(userId: string): Promise<StandingRecord | null> {
    return this.standing.get(userId) ?? null;
  }

  async saveStanding(s: StandingRecord): Promise<void> {
    this.standing.set(s.userId, s);
  }
}

export class InMemoryReturnEventPublisher implements ReturnEventPublisher {
  readonly events: ReturnEvent[] = [];
  failNext = 0;
  async publish(event: ReturnEvent): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error("publish failed");
    }
    this.events.push(event);
  }
  named<N extends ReturnEvent["name"]>(name: N): Extract<ReturnEvent, { name: N }>[] {
    return this.events.filter((e): e is Extract<ReturnEvent, { name: N }> => e.name === name);
  }
}

export class FakeReturnableLines implements ReturnableLinePort {
  private readonly lines = new Map<string, ReturnableLine>();
  add(line: ReturnableLine): void {
    this.lines.set(line.orderLineId, line);
  }
  async find(orderLineId: string): Promise<ReturnableLine | null> {
    return this.lines.get(orderLineId) ?? null;
  }
}

export class StaticReturnsMembership implements MembershipPort {
  private readonly plus = new Set<string>();
  grant(userId: string): void {
    this.plus.add(userId);
  }
  async isPlusMember(userId: string): Promise<boolean> {
    return this.plus.has(userId);
  }
}

export class StaticReturnerHistory implements ReturnerHistoryPort {
  private readonly byUser = new Map<string, ReturnerHistory>();
  set(userId: string, h: ReturnerHistory): void {
    this.byUser.set(userId, h);
  }
  async history(userId: string): Promise<ReturnerHistory> {
    return this.byUser.get(userId) ?? { deliveredOrders: 0, returnedOrders: 0 };
  }
}

/** Every upload is owned by whoever uses it, unless it has been marked foreign. */
export class FakeEvidence implements EvidencePort {
  private readonly foreign = new Set<string>();
  markForeign(uploadId: string): void {
    this.foreign.add(uploadId);
  }
  async ownedBy(_actorId: string, uploadIds: readonly string[]): Promise<boolean> {
    return uploadIds.every((u) => !this.foreign.has(u));
  }
}

export class FakeExchangeStock implements ExchangeStockPort {
  private readonly out = new Set<string>();
  soldOut(skuId: string): void {
    this.out.add(skuId);
  }
  async inStock(skuId: string): Promise<boolean> {
    return !this.out.has(skuId);
  }
}
