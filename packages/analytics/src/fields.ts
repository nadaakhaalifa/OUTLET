import { z } from "zod";

/** Reusable, bounded field schemas. No unbounded free text exists in this vocabulary by design. */

/** Opaque internal identifier (UUID, ULID or prefixed random id). Linkable inside the company, never a name or a number a person knows. */
export const opaqueId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

/** Short lowercase code for values whose enumeration is owned by a module spec that does not exist yet. Tighten to an enum when it lands. */
export const code = z.string().regex(/^[a-z][a-z0-9_]{0,31}$/);

/** Integer minor units (piastres) as a decimal string: JSON has no bigint. At most 9 digits (< 10,000,000.00 EGP). */
export const minorUnits = z.string().regex(/^(?:0|[1-9]\d{0,8})$/);

export const smallCount = z.number().int().min(0).max(10_000);
export const positiveQuantity = z.number().int().min(1).max(99);
export const durationMs = z.number().int().min(0).max(600_000);
export const unitInterval = z.number().min(0).max(1);

export const world = z.enum(["local", "global", "shop_everything", "my_stores"]);

export const onboardingStep = z.enum([
  "auth",
  "age_attestation",
  "language",
  "consents",
  "style_vibes",
  "sizes",
  "favorite_brands",
  "budget",
  "notification_permission",
]);

export const wishlistIntent = z.enum([
  "need",
  "want",
  "treat",
  "buy_later_this_month",
  "birthday",
  "eid_ramadan",
  "gift",
  "custom",
]);

export const paymentMethod = z.enum([
  "card",
  "apple_pay",
  "meeza",
  "mobile_wallet",
  "instapay",
  "fawry",
  "installments",
  "store_credit",
  "gift_card",
  "cod",
]);

export const returnReason = z.enum([
  "too_small",
  "too_large",
  "not_as_described",
  "defective",
  "changed_mind",
  "late",
  "wrong_item",
]);

export const plusPlan = z.enum(["monthly", "yearly", "family", "student", "gift"]);

export const dropType = z.enum([
  "public",
  "members_only",
  "flash_hour",
  "mystery_box",
  "price_ladder",
  "last_chance",
]);

export const refundRoute = z.enum([
  "psp_original",
  "store_credit",
  "bank_transfer",
  "provider_cancellation",
]);

export const coinSource = z.enum([
  "purchase",
  "photo_review",
  "size_profile",
  "fit_feedback",
  "referral",
  "streak",
  "challenge",
]);

export const notificationChannel = z.enum(["push", "in_app", "whatsapp", "sms", "email"]);

export const gameKind = z.enum(["daily_spin", "scratch_card"]);
export const gameOutcomeKind = z.enum(["coins", "voucher", "nothing"]);
export const stylistSource = z.enum(["llm", "rules"]);
export const recommendationModule = z.enum([
  "because_you_bought", "similar_viewed", "similar_for_less", "goes_with", "restock", "price_dropped",
]);
export const adSurface = z.enum(["search", "category"]);
