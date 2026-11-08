import type { CourierWebhookProcessor } from "@outlet/shipping";

export interface ShipmentRow {
  readonly id: string;
  readonly sellerOrderIds: readonly string[];
  readonly courier: string;
  readonly awb: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly deliveredAt: Date | null;
  readonly lastEventAt: Date | null;
}

/** Shopper read of the shipments of one of their own order groups (user context: a foreign group is null, so 404). */
export interface TrackingReaderPort {
  forOrderGroup(userId: string, orderGroupId: string): Promise<readonly ShipmentRow[] | null>;
}

export interface TrackingServices {
  readonly tracking: TrackingReaderPort;
  /** Worker job `shipping.tracking`: verify (courier signature over the raw bytes), store raw, normalise, apply the shipment machine. */
  readonly webhooks: Pick<CourierWebhookProcessor, "handle">;
  /** The one courier wired for this market; a callback addressed to another code is 404. */
  readonly courierCode: string;
}
