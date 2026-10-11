import { money, newShipmentSnapshot } from "../domain/bridge";
import type {
  CourierBinding,
  FulfillmentRepository,
  LabelFile,
  OutboxEvent,
  SellerOrderFacts,
  ShipmentEventRecord,
  ShipmentRecord,
} from "../domain/ports";
import { CourierRejectedError } from "../domain/ports";
import type { Clock, IdGenerator } from "../../../platform/ports";
import type { AwbWorker } from "./awb-worker";
import { shipmentPayload } from "./events";

export const DEFAULT_COURIER = "bosta";
/** Seller order states from which a seller may hand a parcel to the courier (VERIFY with orders). */
export const SHIPPABLE_ORDER_STATUSES: ReadonlySet<string> = new Set(["ACCEPTED", "PACKED"]);

export interface ShipmentView {
  readonly shipment: ShipmentRecord;
  readonly events: readonly ShipmentEventRecord[];
}

export interface ShipmentDeps {
  readonly repo: FulfillmentRepository;
  readonly couriers: ReadonlyMap<string, CourierBinding>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly worker: AwbWorker;
}

export type CreateShipmentResult =
  | { readonly kind: "ok"; readonly view: ShipmentView }
  | { readonly kind: "courier_unsupported" }
  | { readonly kind: "order_not_shippable"; readonly status: string }
  | { readonly kind: "shipment_exists"; readonly shipmentId: string };

/** Authorization has already happened: `order` is the caller's own, verified seller order. */
export class CreateShipment {
  constructor(private readonly deps: ShipmentDeps) {}

  async execute(input: {
    readonly order: SellerOrderFacts;
    readonly courierCode: string | undefined;
    readonly parcel: { readonly weightG: number; readonly pieces: number };
  }): Promise<CreateShipmentResult> {
    const { repo, clock, ids } = this.deps;
    const courierCode = input.courierCode ?? DEFAULT_COURIER;
    if (!this.deps.couriers.has(courierCode)) return { kind: "courier_unsupported" };
    if (!SHIPPABLE_ORDER_STATUSES.has(input.order.status)) {
      return { kind: "order_not_shippable", status: input.order.status };
    }
    const live = await repo.findLiveBySellerOrder(input.order.id);
    if (live !== null) return { kind: "shipment_exists", shipmentId: live.id };

    const nowMs = clock.nowMs();
    const cod = input.order.codAmount !== null && input.order.codAmount.amount > 0n ? input.order.codAmount : null;
    const snap = newShipmentSnapshot(cod !== null);
    const record: ShipmentRecord = {
      id: ids.uuidV7(),
      storeId: input.order.storeId,
      sellerOrderId: input.order.id,
      courierCode,
      awb: null,
      state: snap.state,
      attemptsMade: 0,
      codAmount: cod === null ? null : money(cod.amount, cod.currency),
      codStatus: cod === null ? "NONE" : "PENDING",
      labelStatus: "PENDING",
      parcelWeightG: input.parcel.weightG,
      pieces: input.parcel.pieces,
      pickedUpAtMs: null,
      deliveredAtMs: null,
      version: 0,
      createdAtMs: nowMs,
    };
    const created: OutboxEvent = {
      id: ids.uuidV7(),
      type: "shipment.created",
      aggregateId: record.id,
      payload: shipmentPayload(record),
    };
    const r = await repo.createShipment(record, { nextAttemptAtMs: nowMs }, [created]);
    if (r === "live_shipment_exists") {
      const again = await repo.findLiveBySellerOrder(input.order.id);
      return { kind: "shipment_exists", shipmentId: again?.id ?? record.id };
    }
    // Best effort, never blocks the response: the queue owns retries.
    try {
      await this.deps.worker.attempt(record.id);
    } catch {
      // The job row already carries the failure; the worker will pick it up.
    }
    const stored = await repo.getShipment(record.id);
    return { kind: "ok", view: { shipment: stored ?? record, events: [] } };
  }
}

export class GetShipment {
  constructor(private readonly deps: Pick<ShipmentDeps, "repo">) {}

  async execute(shipmentId: string): Promise<ShipmentView | null> {
    const shipment = await this.deps.repo.getShipment(shipmentId);
    if (shipment === null) return null;
    return { shipment, events: await this.deps.repo.listEvents(shipmentId) };
  }
}

export type LabelResult =
  | { readonly kind: "ok"; readonly file: LabelFile }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_ready" }
  | { readonly kind: "unavailable" };

/** Authorization has already happened. */
export class GetLabel {
  constructor(private readonly deps: Pick<ShipmentDeps, "repo" | "couriers">) {}

  async execute(shipmentId: string): Promise<LabelResult> {
    const s = await this.deps.repo.getShipment(shipmentId);
    if (s === null) return { kind: "not_found" };
    if (s.awb === null || s.labelStatus !== "READY") return { kind: "not_ready" };
    const binding = this.deps.couriers.get(s.courierCode);
    if (binding === undefined) return { kind: "unavailable" };
    try {
      return { kind: "ok", file: await binding.port.getLabel(s.awb) };
    } catch (e) {
      if (e instanceof CourierRejectedError) return { kind: "not_ready" };
      return { kind: "unavailable" };
    }
  }
}

/** Read port implementation for the returns module (`shipment.delivered` is the push side). */
export class RepositoryDeliveredAtReader {
  constructor(private readonly repo: FulfillmentRepository) {}

  async deliveredAtMs(sellerOrderId: string): Promise<number | null> {
    const s = await this.repo.findLiveBySellerOrder(sellerOrderId);
    return s?.deliveredAtMs ?? null;
  }
}
