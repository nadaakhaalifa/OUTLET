import type { ShipmentStatus } from "./shipment-state.js";
import type { StructuredAddress } from "./address.js";

export interface ParcelSpec {
  readonly weightG: number;
  readonly dimsMm?: { readonly lengthMm: number; readonly widthMm: number; readonly heightMm: number };
}

export interface CreateShipmentRequest {
  /** Idempotency key: the HAUL shipment id (replays return the same AWB). */
  readonly shipmentId: string;
  readonly courier: string;
  readonly serviceLevel: string;
  readonly parcels: readonly ParcelSpec[];
  readonly destination: StructuredAddress;
  /** Real recipient contact. Decrypted only for the adapter call (job shipping.tracking), never stored or logged by HAUL. */
  readonly recipient: { readonly name: string; readonly phone: string };
  /** COD amount in minor units; 0n for prepaid. */
  readonly codMinor: bigint;
}
export interface CreatedShipment { readonly awb: string; readonly courier: string }

/** Raw courier event, before normalisation. eventId dedupes replays. */
export interface CourierEvent {
  readonly eventId: string;
  readonly awb: string;
  readonly rawStatus: string;
  readonly occurredAt: string;
}
export interface NormalisedEvent { readonly eventId: string; readonly awb: string; readonly status: ShipmentStatus; readonly occurredAt: string }

/** Courier boundary. No real adapter exists (the contract is an owner decision, V33/V43); production stays unconfigured and fails closed. */
export interface CourierPort {
  createShipment(req: CreateShipmentRequest): Promise<CreatedShipment>;
  cancelShipment(awb: string): Promise<void>;
  /** Maps a raw courier status to the normalised status; undefined for an unknown raw status (never guessed). */
  normalise(event: CourierEvent): NormalisedEvent | undefined;
}

export interface ShipmentLabelPort {
  /** A6 PDF bytes for the AWB. */
  getLabel(awb: string): Promise<{ readonly contentType: "application/pdf"; readonly bytes: Uint8Array }>;
}

/** Verifies and parses a courier tracking webhook. Separate from CourierPort so existing adapters keep compiling. */
export interface CourierWebhookPort {
  /**
   * HMAC / IP check on the raw body and headers, plus a signed timestamp within +-WEBHOOK_TOLERANCE_MS of `now` (replay defence).
   * False = reject; HAUL then stores only the body's sha256 and size, never the body.
   */
  verify(rawBody: string, headers: Readonly<Record<string, string>>, now: Date): boolean;
  /** Raw courier events in the body; throws on a malformed body. */
  parse(rawBody: string): readonly CourierEvent[];
}

/** Webhook timestamp tolerance (master prompt 7: +-5 min). */
export const WEBHOOK_TOLERANCE_MS = 5 * 60_000;
/** Largest accepted webhook body. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;

/** Object storage for label PDFs (labels show recipient data: private bucket). */
export interface LabelStorePort {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
}

/** P3 field envelope (same contract as auth-core FieldCipher); aad binds a ciphertext to its column AND row: `<table>.<column>:<row id>`. */
export interface PiiCipher {
  encrypt(plaintext: string, aad: string): Promise<Uint8Array>;
  decrypt(ciphertext: Uint8Array, aad: string): Promise<string>;
}

/** The order-close job's delivery hook (structurally satisfied by @outlet/checkout OrderCloseJob). */
export interface DeliveryPort {
  markDelivered(sellerOrderId: string, deliveredAt: Date): Promise<unknown>;
}
