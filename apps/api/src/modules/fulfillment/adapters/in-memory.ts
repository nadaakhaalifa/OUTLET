/**
 * DEVELOPMENT FIXTURES and the reference implementation of the repository contract. Per-process,
 * not safe for production (the module refuses to start with real adapters configured).
 */
import type { Actor, Resource } from "@outlet/policy";
import type {
  AwbJob,
  CourierSecretsPort,
  FulfillmentMetrics,
  FulfillmentRepository,
  OutboxEvent,
  RawDelivery,
  RawStatus,
  RecordRawResult,
  RemittanceRecord,
  SellerOrderFacts,
  SellerOrderPort,
  ShipmentEventRecord,
  ShipmentRecord,
  ShipmentUpdate,
} from "../domain/ports";
import { shipmentMachine } from "../domain/bridge";

interface JobState {
  status: "PENDING" | "DONE" | "DEAD";
  attempts: number;
  nextAttemptAtMs: number;
  lastErrorCode: string | null;
}

const NON_LIVE = new Set(["CANCELLED", "LOST", "RETURNED_TO_SELLER"]);

export class InMemoryFulfillmentRepository implements FulfillmentRepository {
  private readonly shipments = new Map<string, ShipmentRecord>();
  private readonly events = new Map<string, ShipmentEventRecord[]>();
  private readonly raw = new Map<string, { delivery: RawDelivery; status: RawStatus }>();
  private readonly jobs = new Map<string, JobState>();
  private readonly remittances = new Map<string, RemittanceRecord>();
  /** Test and observability access: every outbox event, in commit order. */
  readonly outbox: OutboxEvent[] = [];

  private rawKey = (courier: string, eventId: string): string => `${courier}\u0000${eventId}`;

  async createShipment(
    shipment: ShipmentRecord,
    job: { readonly nextAttemptAtMs: number },
    outbox: readonly OutboxEvent[],
  ): Promise<"created" | "live_shipment_exists"> {
    if ((await this.findLiveBySellerOrder(shipment.sellerOrderId)) !== null) return "live_shipment_exists";
    this.shipments.set(shipment.id, shipment);
    this.events.set(shipment.id, []);
    this.jobs.set(shipment.id, {
      status: "PENDING",
      attempts: 0,
      nextAttemptAtMs: job.nextAttemptAtMs,
      lastErrorCode: null,
    });
    this.outbox.push(...outbox);
    return "created";
  }

  async getShipment(id: string): Promise<ShipmentRecord | null> {
    return this.shipments.get(id) ?? null;
  }

  async findByAwb(courierCode: string, awb: string): Promise<ShipmentRecord | null> {
    for (const s of this.shipments.values()) if (s.courierCode === courierCode && s.awb === awb) return s;
    return null;
  }

  async findLiveBySellerOrder(sellerOrderId: string): Promise<ShipmentRecord | null> {
    for (const s of this.shipments.values()) {
      if (s.sellerOrderId === sellerOrderId && !NON_LIVE.has(s.state)) return s;
    }
    return null;
  }

  async listEvents(shipmentId: string): Promise<readonly ShipmentEventRecord[]> {
    // Array.prototype.sort is stable: events with equal times keep their recording order.
    return [...(this.events.get(shipmentId) ?? [])].sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  }

  async recordRaw(raw: RawDelivery): Promise<RecordRawResult> {
    const key = this.rawKey(raw.courierCode, raw.courierEventId);
    const existing = this.raw.get(key);
    if (existing === undefined) {
      this.raw.set(key, { delivery: raw, status: "RECEIVED" });
      return "new";
    }
    return existing.status === "RECEIVED" || existing.status === "UNMATCHED" ? "redelivered" : "duplicate";
  }

  async markRaw(courierCode: string, courierEventId: string, status: RawStatus): Promise<void> {
    const key = this.rawKey(courierCode, courierEventId);
    const r = this.raw.get(key);
    if (r !== undefined) this.raw.set(key, { ...r, status });
  }

  async listUnmatchedRaw(courierCode: string, awb: string): Promise<readonly { courierEventId: string; body: string }[]> {
    return [...this.raw.values()]
      .filter((r) => r.status === "UNMATCHED" && r.delivery.courierCode === courierCode && r.delivery.awb === awb)
      .sort((a, b) => a.delivery.receivedAtMs - b.delivery.receivedAtMs)
      .map((r) => ({ courierEventId: r.delivery.courierEventId, body: r.delivery.body }));
  }

  async applyTracking(input: {
    readonly shipmentId: string;
    readonly expectedVersion: number;
    readonly next: ShipmentRecord;
    readonly event: ShipmentEventRecord;
    readonly courierCode: string;
    readonly outbox: readonly OutboxEvent[];
  }): Promise<"ok" | "version_conflict" | "duplicate_event"> {
    const current = this.shipments.get(input.shipmentId);
    if (current === undefined || current.version !== input.expectedVersion) return "version_conflict";
    const evs = this.events.get(input.shipmentId) ?? [];
    if (evs.some((e) => e.courierEventId === input.event.courierEventId)) {
      await this.markRaw(input.courierCode, input.event.courierEventId, "PROCESSED");
      return "duplicate_event";
    }
    evs.push(input.event);
    this.events.set(input.shipmentId, evs);
    if (input.next.version !== input.expectedVersion) this.shipments.set(input.shipmentId, input.next);
    await this.markRaw(input.courierCode, input.event.courierEventId, "PROCESSED");
    this.outbox.push(...input.outbox);
    return "ok";
  }

  async dueJobs(nowMs: number, limit: number): Promise<readonly AwbJob[]> {
    return [...this.jobs.entries()]
      .filter(([, j]) => j.status === "PENDING" && j.nextAttemptAtMs <= nowMs)
      .sort((a, b) => a[1].nextAttemptAtMs - b[1].nextAttemptAtMs || a[0].localeCompare(b[0]))
      .slice(0, limit)
      .map(([shipmentId, j]) => ({ shipmentId, attempts: j.attempts }));
  }

  async completeAwb(input: {
    readonly shipmentId: string;
    readonly awb: string;
    readonly nowMs: number;
    readonly outbox: readonly OutboxEvent[];
  }): Promise<"ok" | "awb_conflict" | "not_found"> {
    const s = this.shipments.get(input.shipmentId);
    if (s === undefined) return "not_found";
    for (const o of this.shipments.values()) {
      if (o.id !== s.id && o.courierCode === s.courierCode && o.awb === input.awb) return "awb_conflict";
    }
    const state =
      s.state === "LABEL_PENDING" ? shipmentMachine.transition("LABEL_PENDING", "CREATE_LABEL", { cod: s.codAmount !== null, attemptsMade: s.attemptsMade }) : s.state;
    this.shipments.set(s.id, { ...s, awb: input.awb, state, labelStatus: "READY", version: s.version + 1 });
    const j = this.jobs.get(s.id);
    if (j !== undefined) this.jobs.set(s.id, { ...j, status: "DONE", attempts: j.attempts + 1, lastErrorCode: null });
    this.outbox.push(...input.outbox);
    return "ok";
  }

  async failAwb(input: {
    readonly shipmentId: string;
    readonly attempts: number;
    readonly nextAttemptAtMs: number | null;
    readonly errorCode: string;
    readonly nowMs: number;
    readonly outbox: readonly OutboxEvent[];
  }): Promise<void> {
    const j = this.jobs.get(input.shipmentId);
    if (j === undefined) return;
    if (input.nextAttemptAtMs === null) {
      this.jobs.set(input.shipmentId, { ...j, status: "DEAD", attempts: input.attempts, lastErrorCode: input.errorCode });
      const s = this.shipments.get(input.shipmentId);
      if (s !== undefined) this.shipments.set(s.id, { ...s, labelStatus: "FAILED", version: s.version + 1 });
    } else {
      this.jobs.set(input.shipmentId, {
        ...j,
        attempts: input.attempts,
        nextAttemptAtMs: input.nextAttemptAtMs,
        lastErrorCode: input.errorCode,
      });
    }
    this.outbox.push(...input.outbox);
  }

  async getJob(shipmentId: string) {
    const j = this.jobs.get(shipmentId);
    return j === undefined ? null : { ...j };
  }

  async requeueDead(shipmentId: string, nowMs: number): Promise<boolean> {
    const j = this.jobs.get(shipmentId);
    if (j === undefined || j.status !== "DEAD") return false;
    this.jobs.set(shipmentId, { status: "PENDING", attempts: 0, nextAttemptAtMs: nowMs, lastErrorCode: null });
    const s = this.shipments.get(shipmentId);
    if (s !== undefined) this.shipments.set(s.id, { ...s, labelStatus: "PENDING", version: s.version + 1 });
    return true;
  }

  async recordRemittance(input: {
    readonly remittance: RemittanceRecord;
    readonly updates: readonly ShipmentUpdate[];
    readonly outbox: readonly OutboxEvent[];
  }): Promise<"recorded" | "duplicate" | "version_conflict"> {
    const key = this.rawKey(input.remittance.courierCode, input.remittance.courierRef);
    if (this.remittances.has(key)) return "duplicate";
    for (const u of input.updates) {
      if (this.shipments.get(u.shipmentId)?.version !== u.expectedVersion) return "version_conflict";
    }
    for (const u of input.updates) this.shipments.set(u.shipmentId, u.next);
    this.remittances.set(key, input.remittance);
    this.outbox.push(...input.outbox);
    return "recorded";
  }

  async findRemittance(courierCode: string, courierRef: string): Promise<RemittanceRecord | null> {
    return this.remittances.get(this.rawKey(courierCode, courierRef)) ?? null;
  }

  /** Test helper: the stored raw status of a delivery. */
  rawStatusForTest(courierCode: string, courierEventId: string): RawStatus | null {
    return this.raw.get(this.rawKey(courierCode, courierEventId))?.status ?? null;
  }
}

export class InMemoryFulfillmentMetrics implements FulfillmentMetrics {
  readonly counters = new Map<string, number>();

  increment(name: string, labels: Readonly<Record<string, string>> = {}): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  /** Test helper. */
  get(name: string, labels: Readonly<Record<string, string>> = {}): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  private key(name: string, labels: Readonly<Record<string, string>>): string {
    const parts = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    return parts.length === 0 ? name : `${name}{${parts.join(",")}}`;
  }
}

export class StaticCourierSecrets implements CourierSecretsPort {
  constructor(private readonly byCourier: Readonly<Record<string, readonly string[]>> = {}) {}

  async webhookSecrets(courierCode: string): Promise<readonly string[]> {
    return this.byCourier[courierCode] ?? [];
  }
}

export class FakeSellerOrders implements SellerOrderPort {
  private readonly byId = new Map<string, SellerOrderFacts>();

  add(order: SellerOrderFacts): void {
    this.byId.set(order.id, order);
  }

  async find(sellerOrderId: string): Promise<SellerOrderFacts | null> {
    return this.byId.get(sellerOrderId) ?? null;
  }
}

/**
 * Resolves a shipment id to a policy resource (type store_order: the seller order is the parent,
 * see spec "Policy mapping note"). Unknown ids resolve to null, which decide() turns into 404.
 */
export class ShipmentResolver {
  constructor(private readonly repo: FulfillmentRepository) {}

  async resolve(input: { readonly id: string | undefined; readonly actor: Actor }): Promise<Resource | null> {
    if (input.id === undefined || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.id)) {
      return null;
    }
    const s = await this.repo.getShipment(input.id);
    if (s === null) return null;
    return { type: "store_order", id: s.id, storeId: s.storeId, state: "active" };
  }
}
