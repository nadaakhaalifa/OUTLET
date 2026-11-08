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
