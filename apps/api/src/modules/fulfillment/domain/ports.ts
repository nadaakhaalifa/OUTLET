import type {
  CodMatchStatus,
  CodStatus,
  FulfillmentTrackingKind,
  Money,
  ShipmentState,
} from "./bridge";

// ---------------------------------------------------------------------------------------------
// Courier (outbound) port
// ---------------------------------------------------------------------------------------------

export interface RecipientFacts {
  /** P2. Passed to the courier, never logged and never put in events. */
  readonly name: string;
  readonly phone: string;
  readonly governorate: string;
  readonly city: string;
  readonly addressLine: string;
}

export interface PickupFacts {
  readonly label: string;
  readonly governorate: string;
  readonly city: string;
  readonly addressLine: string;
}

export interface AwbRequest {
  /** Courier-side idempotency reference (`businessReference`): createAwb twice yields one AWB. */
  readonly shipmentId: string;
  readonly parcel: { readonly weightG: number; readonly pieces: number };
  /** Null for prepaid. */
  readonly cod: Money | null;
  readonly recipient: RecipientFacts;
  readonly pickup: PickupFacts;
}

export interface LabelFile {
  readonly contentType: "application/pdf";
  readonly bytes: Uint8Array;
}

/** A tracking fact a poll returned, already normalized (same shape the webhook produces). */
export interface PolledTrackingFact {
  readonly courierEventId: string;
  readonly rawStatus: string;
  readonly kind: FulfillmentTrackingKind | null;
  readonly occurredAtMs: number;
  readonly reasonCode: string | null;
}

/** Transient failure (timeout, 5xx, circuit open): the caller retries with backoff. */
export class CourierUnavailableError extends Error {
  constructor(detail = "courier unavailable") {
    super(detail);
    this.name = "CourierUnavailableError";
  }
}

/** Permanent failure (validation, unserviceable area): retrying cannot help. */
export class CourierRejectedError extends Error {
  constructor(
    readonly code: string,
    detail = "courier rejected the request",
  ) {
    super(detail);
    this.name = "CourierRejectedError";
  }
}

export interface CourierPort {
  readonly code: string;
  /** Idempotent by `req.shipmentId`. */
  createAwb(req: AwbRequest): Promise<{ readonly awb: string }>;
  getLabel(awb: string): Promise<LabelFile>;
  track(awb: string): Promise<readonly PolledTrackingFact[]>;
  /** `too_late` when the parcel is already with the courier. */
  cancel(awb: string): Promise<"cancelled" | "too_late">;
}

// ---------------------------------------------------------------------------------------------
// Courier (inbound) webhook adapter
// ---------------------------------------------------------------------------------------------

export type WebhookVerification = "ok" | "missing_headers" | "bad_signature" | "stale_timestamp";

export type ParsedCourierWebhook =
  | {
      readonly kind: "tracking";
      readonly courierEventId: string;
      readonly awb: string;
      readonly rawStatus: string;
      /** Null when the courier status has no mapping (acknowledged, never an error). */
      readonly tracking: FulfillmentTrackingKind | null;
      readonly occurredAtMs: number;
      readonly reasonCode: string | null;
    }
  | {
      readonly kind: "cod_remitted";
      readonly courierEventId: string;
      readonly courierRef: string;
      readonly remittanceDate: string;
      readonly lines: readonly { readonly awb: string; readonly collected: Money; readonly fee: Money }[];
    }
  | { readonly kind: "invalid" };

export interface CourierWebhookAdapter {
  readonly code: string;
  readonly maxBodyBytes: number;
  /** `secrets` is the current rotation list; any one may verify. Constant time. */
  verify(
    input: { readonly rawBody: string; readonly headers: Readonly<Record<string, string | undefined>> },
    secrets: readonly string[],
    nowMs: number,
  ): WebhookVerification;
  /** Called only after `verify` returned ok. Never throws. */
  parse(rawBody: string): ParsedCourierWebhook;
}

export interface CourierBinding {
  readonly port: CourierPort;
  readonly webhook: CourierWebhookAdapter;
}

export interface CourierSecretsPort {
  /** Current webhook secrets for a courier (rotation: more than one). Empty means reject all. */
  webhookSecrets(courierCode: string): Promise<readonly string[]>;
}

// ---------------------------------------------------------------------------------------------
// Orders (read-only)
// ---------------------------------------------------------------------------------------------

export interface SellerOrderFacts {
  readonly id: string;
  readonly storeId: string;
  readonly status: string;
  /** Unpaid amount to collect at the door. Null (or zero) means prepaid. */
  readonly codAmount: Money | null;
  readonly recipient: RecipientFacts;
  readonly pickup: PickupFacts;
}

export interface SellerOrderPort {
  find(sellerOrderId: string): Promise<SellerOrderFacts | null>;
}

// ---------------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------------

export type LabelStatus = "PENDING" | "READY" | "FAILED";

export interface ShipmentRecord {
  readonly id: string;
  readonly storeId: string;
  readonly sellerOrderId: string;
  readonly courierCode: string;
  readonly awb: string | null;
  readonly state: ShipmentState;
  readonly attemptsMade: number;
  /** Fixed at dispatch. Null when not COD. */
  readonly codAmount: Money | null;
  readonly codStatus: CodStatus;
  readonly labelStatus: LabelStatus;
  readonly parcelWeightG: number;
  readonly pieces: number;
  readonly pickedUpAtMs: number | null;
  /** Courier-confirmed. Starts every legal window (returns, 14/30 days). */
  readonly deliveredAtMs: number | null;
  readonly version: number;
  readonly createdAtMs: number;
}

export type EventOutcome = "APPLIED" | "IGNORED_STALE" | "IGNORED_INVALID";

export interface ShipmentEventRecord {
  readonly id: string;
  readonly shipmentId: string;
  readonly courierEventId: string;
  readonly kind: string;
  readonly outcome: EventOutcome;
  readonly fromStatus: ShipmentState;
  readonly toStatus: ShipmentState;
  readonly reasonCode: string | null;
  readonly occurredAtMs: number;
  readonly recordedAtMs: number;
}

export type OutboxPayload = Readonly<Record<string, string | number | boolean | null>>;

/** Written in the same transaction as the state change (A2.7). Opaque ids and statuses only. */
export interface OutboxEvent {
  readonly id: string;
  readonly type: string;
  readonly aggregateId: string;
  readonly payload: OutboxPayload;
}

export type RawStatus = "RECEIVED" | "PROCESSED" | "UNMATCHED" | "IGNORED_UNKNOWN_STATUS";

export interface RawDelivery {
  readonly id: string;
  readonly courierCode: string;
  readonly courierEventId: string;
  readonly awb: string | null;
  readonly body: string;
  readonly receivedAtMs: number;
}

export type RecordRawResult =
  /** First delivery. */
  | "new"
  /** Seen before and fully processed (or deliberately ignored): acknowledge and do nothing. */
  | "duplicate"
  /** Seen before but processing never finished (crash): process again, idempotently. */
  | "redelivered";

export interface AwbJob {
  readonly shipmentId: string;
  readonly attempts: number;
}

export interface RemittanceLineRecord {
  readonly awb: string;
  readonly shipmentId: string | null;
  readonly collected: Money;
  readonly fee: Money;
  readonly match: CodMatchStatus;
}

export interface RemittanceRecord {
  readonly id: string;
  readonly courierCode: string;
  readonly courierRef: string;
  readonly remittanceDate: string;
  readonly total: Money;
  readonly status: "RECEIVED" | "MATCHED" | "PARTIALLY_MATCHED" | "MISMATCH";
  readonly receivedAtMs: number;
  readonly lines: readonly RemittanceLineRecord[];
}

export interface ShipmentUpdate {
  readonly shipmentId: string;
  readonly expectedVersion: number;
  readonly next: ShipmentRecord;
}

export interface FulfillmentRepository {
  /**
   * Inserts the shipment (state LABEL_PENDING), its AWB job (due now) and outbox events atomically.
   * `live_shipment_exists` when the seller order already has a live shipment.
   */
  createShipment(
    shipment: ShipmentRecord,
    job: { readonly nextAttemptAtMs: number },
    outbox: readonly OutboxEvent[],
  ): Promise<"created" | "live_shipment_exists">;
  getShipment(id: string): Promise<ShipmentRecord | null>;
  findByAwb(courierCode: string, awb: string): Promise<ShipmentRecord | null>;
  findLiveBySellerOrder(sellerOrderId: string): Promise<ShipmentRecord | null>;
  /** Oldest first. */
  listEvents(shipmentId: string): Promise<readonly ShipmentEventRecord[]>;

  recordRaw(raw: RawDelivery): Promise<RecordRawResult>;
  markRaw(courierCode: string, courierEventId: string, status: RawStatus, atMs: number): Promise<void>;
  /** Raw deliveries held as UNMATCHED for an AWB, oldest first. */
  listUnmatchedRaw(courierCode: string, awb: string): Promise<readonly { courierEventId: string; body: string }[]>;

  /**
   * One transaction: insert the event row (unique per shipment and courier event id), update the
   * shipment when `next.version` differs from `expectedVersion` (compare-and-set), mark the raw
   * delivery PROCESSED, append outbox events.
   */
  applyTracking(input: {
    readonly shipmentId: string;
    readonly expectedVersion: number;
    readonly next: ShipmentRecord;
    readonly event: ShipmentEventRecord;
    readonly courierCode: string;
    readonly outbox: readonly OutboxEvent[];
  }): Promise<"ok" | "version_conflict" | "duplicate_event">;

  /** Due PENDING jobs, oldest first. Claiming is the caller's attempt; results go through complete/fail. */
  dueJobs(nowMs: number, limit: number): Promise<readonly AwbJob[]>;
  /**
   * Stores the AWB, moves LABEL_PENDING -> LABEL_CREATED, label READY, job DONE, appends outbox.
   * `awb_conflict` when the AWB is already used by another shipment.
   */
  completeAwb(input: {
    readonly shipmentId: string;
    readonly awb: string;
    readonly nowMs: number;
    readonly outbox: readonly OutboxEvent[];
  }): Promise<"ok" | "awb_conflict" | "not_found">;
  /** `nextAttemptAtMs === null` dead-letters the job and marks the label FAILED. */
  failAwb(input: {
    readonly shipmentId: string;
    readonly attempts: number;
    readonly nextAttemptAtMs: number | null;
    readonly errorCode: string;
    readonly nowMs: number;
    readonly outbox: readonly OutboxEvent[];
  }): Promise<void>;
  getJob(shipmentId: string): Promise<{ status: "PENDING" | "DONE" | "DEAD"; attempts: number; nextAttemptAtMs: number; lastErrorCode: string | null } | null>;
  requeueDead(shipmentId: string, nowMs: number): Promise<boolean>;

  /** Idempotent on (courier, courierRef). Applies the shipment updates in the same transaction. */
  recordRemittance(input: {
    readonly remittance: RemittanceRecord;
    readonly updates: readonly ShipmentUpdate[];
    readonly outbox: readonly OutboxEvent[];
  }): Promise<"recorded" | "duplicate" | "version_conflict">;
  findRemittance(courierCode: string, courierRef: string): Promise<RemittanceRecord | null>;
}

export interface FulfillmentMetrics {
  increment(name: string, labels?: Readonly<Record<string, string>>): void;
}

/** Read port for the returns module: the courier-confirmed delivery time of a seller order. */
export interface DeliveredAtReader {
  deliveredAtMs(sellerOrderId: string): Promise<number | null>;
}
