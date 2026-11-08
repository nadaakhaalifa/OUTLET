import { z } from "zod";

const Iso = z.iso.datetime();

export const OrderGroupIdParams = z.strictObject({ order_group_id: z.uuid() });
export type OrderGroupIdParams = z.infer<typeof OrderGroupIdParams>;
export const CourierParams = z.strictObject({ courier_code: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/) });
export type CourierParams = z.infer<typeof CourierParams>;

/** The courier's raw status codes and AWB payloads never leave the server: only HAUL's normalised status does. */
const Shipment = z.strictObject({
  id: z.uuid(),
  seller_order_ids: z.array(z.uuid()).max(50),
  courier: z.string().max(40),
  awb: z.string().max(64).nullable(),
  status: z.enum(["LABEL_PENDING", "LABEL_READY", "PICKED_UP", "IN_TRANSIT", "OUT_FOR_DELIVERY", "DELIVERED", "DELIVERY_FAILED", "RTO", "RETURNED_TO_SELLER", "CANCELLED"]),
  attempts: z.number().int().min(0).max(10),
  delivered_at: Iso.nullable(),
  /** The most recent normalised tracking event; no per-event history is stored for shoppers. */
  latest_event: z.strictObject({ status: z.string().max(40), occurred_at: Iso }).nullable(),
});
export const OrderTracking = z.strictObject({ order_group_id: z.uuid(), shipments: z.array(Shipment).max(50), server_time: Iso });
export type OrderTracking = z.infer<typeof OrderTracking>;

export const CourierWebhookAck = z.strictObject({ received: z.boolean(), duplicate: z.boolean() });
export type CourierWebhookAck = z.infer<typeof CourierWebhookAck>;
