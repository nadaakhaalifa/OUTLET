import { isTerminal } from "../domain/bridge";
import type {
  CreateSagaResult,
  OutboxDraft,
  PaymentEventRecord,
  SagaRecord,
  SagaRepository,
} from "../domain/ports";

/** In-memory SagaRepository (development and tests). Same contract suite as the Kysely adapter. */
export class InMemorySagaRepository implements SagaRepository {
  private readonly sagas = new Map<string, SagaRecord>();
  private readonly events = new Map<string, PaymentEventRecord & { appliedAtMs: number | null }>();
  /** Everything emitted to the outbox, in order (inspected by tests). */
  readonly outbox: OutboxDraft[] = [];

  async create(record: SagaRecord, events: readonly OutboxDraft[]): Promise<CreateSagaResult> {
    for (const s of this.sagas.values()) {
      if (s.userId === record.userId && s.idempotencyKey === record.idempotencyKey) {
        return { kind: "duplicate_key", existing: s };
      }
    }
    for (const s of this.sagas.values()) {
      if (s.userId === record.userId && s.cartHash === record.cartHash && !isTerminal(s.facts.status)) {
        return { kind: "duplicate_cart", existing: s };
      }
    }
    this.sagas.set(record.orderGroupId, record);
    this.outbox.push(...events);
    return { kind: "created" };
  }

  async get(orderGroupId: string): Promise<SagaRecord | null> {
    return this.sagas.get(orderGroupId) ?? null;
  }

  async getForUser(orderGroupId: string, userId: string): Promise<SagaRecord | null> {
    const s = this.sagas.get(orderGroupId);
    return s !== undefined && s.userId === userId ? s : null;
  }

  async findByKey(userId: string, idempotencyKey: string): Promise<SagaRecord | null> {
    for (const s of this.sagas.values()) if (s.userId === userId && s.idempotencyKey === idempotencyKey) return s;
    return null;
  }

  async save(next: SagaRecord, expectedVersion: number, events: readonly OutboxDraft[]): Promise<boolean> {
    const cur = this.sagas.get(next.orderGroupId);
    if (cur === undefined || cur.version !== expectedVersion) return false;
    this.sagas.set(next.orderGroupId, next);
    this.outbox.push(...events);
    return true;
  }

  async due(nowMs: number, limit: number): Promise<readonly SagaRecord[]> {
    return [...this.sagas.values()]
      .filter((s) => !isTerminal(s.facts.status) && !s.stuck && s.nextWakeAtMs !== null && s.nextWakeAtMs <= nowMs)
      .sort((a, b) => (a.nextWakeAtMs ?? 0) - (b.nextWakeAtMs ?? 0) || (a.orderGroupId < b.orderGroupId ? -1 : 1))
      .slice(0, limit);
  }

  async recordPaymentEvent(e: PaymentEventRecord): Promise<"new" | "duplicate"> {
    const key = `${e.provider}:${e.eventId}`;
    if (this.events.has(key)) return "duplicate";
    this.events.set(key, { ...e, appliedAtMs: null });
    return "new";
  }

  async markPaymentEventApplied(provider: string, eventId: string, atMs: number): Promise<void> {
    const e = this.events.get(`${provider}:${eventId}`);
    if (e !== undefined) this.events.set(`${provider}:${eventId}`, { ...e, appliedAtMs: atMs });
  }

  paymentEvents(): readonly (PaymentEventRecord & { appliedAtMs: number | null })[] {
    return [...this.events.values()];
  }
}
