/**
 * Wire shapes of the seller-settings routes (the OpenAPI declares these bodies as open objects; the controller's
 * Zod schemas in apps/api/src/modules/seller-settings/adapters/controller.ts are authoritative). Parsed with
 * Zod at the boundary so a drifting server fails loudly instead of rendering undefined.
 */
import { z } from "zod";
import type { NotificationEvent } from "./model";

const Money = z.object({ amount: z.string(), currency: z.literal("EGP") });

export const ProfileWire = z.object({
  name_ar: z.string(),
  name_en: z.string().nullish(),
  description_ar: z.string().nullish(),
  description_en: z.string().nullish(),
  social_links: z.record(z.string(), z.string()),
  return_policy: z.object({
    change_of_mind_days: z.number(),
    defect_days: z.number(),
    text_ar: z.string().nullish(),
    text_en: z.string().nullish(),
  }),
  free_delivery_threshold: Money,
  vacation: z.object({ enabled: z.boolean(), until: z.string().nullable(), eta_extra_days: z.number() }),
  version: z.number(),
});
export type ProfileWire = z.infer<typeof ProfileWire>;

export const ShippingWire = z.union([
  z.object({ configured: z.literal(false), handling_time_hours: z.number() }),
  z.object({
    configured: z.literal(true),
    origin: z.object({
      governorate_code: z.string(),
      city_code: z.string(),
      street: z.string(),
      building: z.string().nullish(),
      landmark: z.string(),
      contact_name: z.string(),
      contact_phone_masked: z.string(),
      pin: z.object({ lat: z.number(), lng: z.number() }).nullish(),
    }),
    handling_time_hours: z.number(),
    courier_preferences: z.record(z.string(), z.array(z.string())),
    packaging_options: z.array(z.string()),
  }),
]);
export type ShippingWire = z.infer<typeof ShippingWire>;

export const BankWire = z.union([
  z.object({ configured: z.literal(false) }),
  z.object({
    configured: z.literal(true),
    iban_last4: z.string(),
    name_match_score: z.number(),
    activates_at: z.string().nullable(),
  }),
]);

export const PrefsWire = z.object({
  preferences: z.record(z.string(), z.record(z.string(), z.boolean())),
});

export const UploadWire = z.object({
  upload_id: z.string(),
  upload_url: z.string(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
});
export const BulkUploadWire = z.object({ items: z.array(UploadWire) });
export const InviteWire = z.object({ id: z.string(), role: z.string(), phone_masked: z.string().nullish(), status: z.string() });
/** GET /v1/seller/stores/{storeId}/team (seller-settings controller): active members and invites. */
export const TeamWire = z.object({
  members: z.array(z.object({ user_id: z.string(), role: z.string(), phone_masked: z.string().nullish() })),
  invites: z.array(z.object({ id: z.string(), role: z.string(), phone_masked: z.string().nullish(), status: z.string() })),
});

/**
 * App notification toggle -> wire event. The app toggles the push channel only; transactional events keep
 * in-app delivery regardless (server rule), so the locked ones are never written.
 */
export const NOTIFICATION_WIRE: Readonly<Record<NotificationEvent, string>> = {
  new_order: "new_order",
  sla_warning: "order_sla_warning",
  low_stock: "stock_low",
  payout: "payout_sent",
  price_trust: "price_claim_action",
};
