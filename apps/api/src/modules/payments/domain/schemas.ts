import { z } from "zod";
import { PAYMENT_METHOD_IDS } from "./seam";

/** Wire bigint: decimal string of integer piastres (no floats anywhere). */
export const PiastresWire = z
  .string()
  .regex(/^(0|[1-9]\d{0,17})$/, "amount must be a non-negative integer of piastres")
  .transform((s) => BigInt(s));

export const MethodSchema = z.enum(PAYMENT_METHOD_IDS);

/** What the shopper's app must do next. Closed set; the app never executes anything from a PSP. */
export const ClientActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("redirect"), url: z.url().max(2048) }).strict(),
  z.object({ kind: z.literal("iframe"), url: z.url().max(2048) }).strict(),
  z
    .object({
      kind: z.literal("reference_code"),
      reference: z.string().min(4).max(32).regex(/^[0-9A-Za-z-]+$/),
      expires_at_ms: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("wallet_prompt"), message_code: z.string().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("qr_payload"), payload: z.string().min(1).max(2048) }).strict(),
  z.object({ kind: z.literal("apple_pay_session"), session_url: z.url().max(2048) }).strict(),
]);
export type ClientAction = z.infer<typeof ClientActionSchema>;

export const SAVED_CARD_BRANDS = ["visa", "mastercard", "meeza", "amex", "other"] as const;

/** A saved card is a PSP token plus display data. There is deliberately no PAN, CVV or holder name. */
export const SavedCardSchema = z
  .object({
    psp_token: z.string().min(8).max(256),
    brand: z.enum(SAVED_CARD_BRANDS),
    last4: z.string().regex(/^\d{4}$/),
    exp_month: z.number().int().min(1).max(12),
    exp_year: z.number().int().min(2000).max(2200),
    fingerprint: z.string().min(8).max(128),
  })
  .strict();
export type SavedCardInput = z.infer<typeof SavedCardSchema>;

export const SavedCardViewSchema = z
  .object({
    id: z.string(),
    brand: z.enum(SAVED_CARD_BRANDS),
    last4: z.string().regex(/^\d{4}$/),
    exp_month: z.number().int(),
    exp_year: z.number().int(),
  })
  .strict();

export const AvailabilityQuerySchema = z
  .object({
    amount: PiastresWire,
    contains_drop_sku: z.enum(["true", "false"]).default("false"),
  })
  .strict();

export const IdParamSchema = z.uuid();
