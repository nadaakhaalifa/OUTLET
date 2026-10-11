import {
  awbBackoffMs,
  awbRetryDecision,
  applyAwbCreated,
  newShipmentSnapshot,
} from "../domain/bridge";
import {
  CourierRejectedError,
  CourierUnavailableError,
  type CourierBinding,
  type FulfillmentMetrics,
  type FulfillmentRepository,
  type OutboxEvent,
  type SellerOrderPort,
} from "../domain/ports";
import type { Clock, IdGenerator } from "../../../platform/ports";
import { shipmentPayload } from "./events";

export interface AwbWorkerDeps {
  readonly repo: FulfillmentRepository;
  readonly orders: SellerOrderPort;
  readonly couriers: ReadonlyMap<string, CourierBinding>;
  readonly metrics: FulfillmentMetrics;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Called after an AWB is stored, so held (unmatched) tracking facts can be re-applied. */
  readonly afterAwbAssigned?: (courierCode: string, awb: string) => Promise<void>;
}

export type AwbAttemptResult = "created" | "retry_scheduled" | "dead_lettered" | "skipped";

/** Jitter in [0, 1) from the id generator's CSPRNG. Keeps this module free of Math.random. */
function jitter(ids: IdGenerator): number {
  return parseInt(ids.hex(2), 16) / 65_536;
}

/**
 * AWB creation queue (spec 21 failure handling). One attempt is: createAwb (idempotent by shipment
 * id) then store the AWB and the LABEL_CREATED transition atomically. Transient failures back
 * off exponentially with jitter and dead-letter after the policy maximum (DLQ metric + event).
 */
export class AwbWorker {
  constructor(private readonly deps: AwbWorkerDeps) {}

  async runDue(limit = 25): Promise<{ attempted: number; created: number; retried: number; dead: number }> {
    const jobs = await this.deps.repo.dueJobs(this.deps.clock.nowMs(), limit);
    const tally = { attempted: 0, created: 0, retried: 0, dead: 0 };
    for (const job of jobs) {
      const r = await this.attempt(job.shipmentId);
      if (r === "skipped") continue;
      tally.attempted += 1;
      if (r === "created") tally.created += 1;
      if (r === "retry_scheduled") tally.retried += 1;
      if (r === "dead_lettered") tally.dead += 1;
    }
    return tally;
  }

  async attempt(shipmentId: string): Promise<AwbAttemptResult> {
    const { repo, clock, ids, metrics } = this.deps;
    const job = await repo.getJob(shipmentId);
    if (job === null || job.status !== "PENDING") return "skipped";
    const shipment = await repo.getShipment(shipmentId);
    if (shipment === null) return "skipped";
    if (shipment.awb !== null) return "skipped";
    const binding = this.deps.couriers.get(shipment.courierCode);
    const nowMs = clock.nowMs();
    const attempts = job.attempts + 1;

    const dead = async (code: string): Promise<AwbAttemptResult> => {
      const event: OutboxEvent = {
        id: ids.uuidV7(),
        type: "courier.awb_dead_lettered",
        aggregateId: shipmentId,
        payload: { ...shipmentPayload(shipment), attempts, error_code: code },
      };
      await repo.failAwb({ shipmentId, attempts, nextAttemptAtMs: null, errorCode: code, nowMs, outbox: [event] });
      metrics.increment("fulfillment_awb_dlq_total", { courier: shipment.courierCode });
      return "dead_lettered";
    };

    if (binding === undefined) return dead("courier_unsupported");
    const order = await this.deps.orders.find(shipment.sellerOrderId);
    if (order === null) return dead("order_missing");

    try {
      const { awb } = await binding.port.createAwb({
        shipmentId,
        parcel: { weightG: shipment.parcelWeightG, pieces: shipment.pieces },
        cod: shipment.codAmount,
        recipient: order.recipient,
        pickup: order.pickup,
      });
      const after = applyAwbCreated(newShipmentSnapshot(shipment.codAmount !== null));
      const event: OutboxEvent = {
        id: ids.uuidV7(),
        type: "shipment.label_created",
        aggregateId: shipmentId,
        payload: { ...shipmentPayload({ ...shipment, awb, state: after.state }) },
      };
      const stored = await repo.completeAwb({ shipmentId, awb, nowMs, outbox: [event] });
      if (stored === "awb_conflict") return dead("awb_conflict");
      if (stored === "not_found") return "skipped";
      metrics.increment("fulfillment_awb_created_total", { courier: shipment.courierCode });
      if (this.deps.afterAwbAssigned !== undefined) await this.deps.afterAwbAssigned(shipment.courierCode, awb);
      return "created";
    } catch (e) {
      if (e instanceof CourierRejectedError) return dead(e.code.slice(0, 64));
      if (!(e instanceof CourierUnavailableError)) {
        // Unknown failure: treated as transient, but recorded under a distinct code.
        return this.retryOrDead(shipment.courierCode, shipmentId, attempts, "unexpected_error", dead);
      }
      return this.retryOrDead(shipment.courierCode, shipmentId, attempts, "courier_unavailable", dead);
    }
  }

  private async retryOrDead(
    courier: string,
    shipmentId: string,
    attempts: number,
    code: string,
    dead: (code: string) => Promise<AwbAttemptResult>,
  ): Promise<AwbAttemptResult> {
    const { repo, clock, ids, metrics } = this.deps;
    if (awbRetryDecision(attempts) === "dead_letter") return dead(code);
    const nowMs = clock.nowMs();
    await repo.failAwb({
      shipmentId,
      attempts,
      nextAttemptAtMs: nowMs + awbBackoffMs(attempts, jitter(ids)),
      errorCode: code,
      nowMs,
      outbox: [],
    });
    metrics.increment("fulfillment_awb_retry_total", { courier });
    return "retry_scheduled";
  }

  /** Ops tool: put a dead job back on the queue with a fresh attempt budget. */
  async requeue(shipmentId: string): Promise<boolean> {
    return this.deps.repo.requeueDead(shipmentId, this.deps.clock.nowMs());
  }
}
