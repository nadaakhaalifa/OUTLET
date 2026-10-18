import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Provisioning of a store from `brand_application.approved` (spec brand-onboarding section 6,
 * docs/specs/brand-review-and-provisioning.md). Ports below are the ones this slice CONSUMES.
 */

export const ETA_STATUSES = ["unknown", "registered", "not_registered"] as const;
export type EtaStatus = (typeof ETA_STATUSES)[number];

const Uuid = z.uuid();

/** Payload of `brand_application.approved` (snake_case wire, validated at the boundary). */
export const ApprovedPayload = z
  .object({
    application_id: Uuid,
    applicant_seller_user_id: Uuid,
    brand_kind: z.enum(["local", "global"]),
    country: z.string().regex(/^[A-Z]{2}$/),
    brand_name: z.string().trim().min(1).max(120),
    brand_name_ar: z.string().trim().min(1).max(120).nullish(),
    locale: z.enum(["ar", "en"]).default("ar"),
    legal_name_ar: z.string().trim().min(1).max(200).nullish(),
    legal_name_en: z.string().trim().min(1).max(200).nullish(),
    /** Commercial register no (EG) or company registration no (global). */
    registration_no: z.string().trim().min(1).max(60).nullish(),
    tax_card_no: z.string().trim().min(1).max(60).nullish(),
    governorate: z.string().trim().min(1).max(60).nullish(),
    slug_hint: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).max(60).nullish(),
    eta_registration: z.enum(ETA_STATUSES).nullish(),
    restricted_listing: z.boolean().default(false),
  })
  .passthrough();
export type ApprovedPayload = z.infer<typeof ApprovedPayload>;

export const ONBOARDING_CHECKLIST = [
  "complete_store_profile",
  "add_arabic_store_title",
  "add_english_store_name",
  "add_store_logo",
  "add_payout_iban",
  "add_pickup_address",
  "add_size_chart_template",
  "publish_first_product",
] as const;
export type ChecklistItemCode = (typeof ONBOARDING_CHECKLIST)[number];

/** Owner membership for the applicant (seller auth). Idempotent per (store, user). */
export interface SellerMembershipsPort {
  grantOwner(input: { readonly sellerUserId: string; readonly storeId: string }): Promise<void>;
}

/** Seller onboarding checklist seed and ETA registration placeholder. Idempotent per store. */
export interface StoreOnboardingPort {
  seedChecklist(storeId: string, items: readonly ChecklistItemCode[]): Promise<void>;
  /** Egypt only: records what the applicant declared; real ETA enrolment is a later step. */
  setEtaRegistration(storeId: string, status: EtaStatus): Promise<void>;
}

/** Write-back to the application (sellers module): the outcome of provisioning. */
export interface ProvisioningApplicationPort {
  payloadFor(applicationId: string): Promise<ApprovedPayload | null>;
  markProvisioned(applicationId: string, storeId: string): Promise<void>;
  markProvisioningFailed(applicationId: string, code: ProvisioningFailureCode): Promise<void>;
  /** Applications parked in PROVISIONING_FAILED (admin retry sweep). */
  listFailed(limit: number): Promise<readonly string[]>;
}

export type ProvisioningFailureCode = "store_name_conflict" | "provisioning_error";

/** Admin conflict queue entry for a duplicate store name. */
export interface ConflictQueuePort {
  enqueue(c: {
    readonly applicationId: string;
    readonly reason: "store_name_conflict";
    readonly conflictingStoreId: string;
  }): Promise<void>;
}

/** Outbox publisher (same transaction as the store write in the Postgres adapter). */
export interface ProvisioningEventsPort {
  /** `key` is the idempotency key (the store id): publishing twice with the same key emits once. */
  publish(e: { readonly type: "store.provisioned"; readonly key: string; readonly payload: Readonly<Record<string, string | boolean | null>> }): Promise<void>;
}

export interface InboxRunner {
  runOnce<T>(
    consumer: string,
    messageId: string,
    fn: () => Promise<T>,
  ): Promise<{ readonly kind: "duplicate" } | { readonly kind: "done"; readonly value: T }>;
}

export interface BrandNotifierPort {
  /** Sends in-app + push + email (per template channels and consent) in the applicant locale. */
  notify(input: {
    readonly userId: string;
    readonly templateKey: BrandTemplateKey;
    readonly ref: string;
    readonly brandName: string;
    readonly deepLink: string;
  }): Promise<void>;
}

/** Moves a SUBMITTED application through AUTO_CHECKS to IN_REVIEW (sellers `runAutoChecks`). Idempotent. */
export interface AutoChecksPort {
  run(applicationId: string): Promise<void>;
}

export const BRAND_TEMPLATE_KEYS = [
  "brand_application_received",
  "brand_application_needs_info",
  "brand_application_approved",
  "brand_application_rejected",
  "brand_application_appeal_result",
] as const;
export type BrandTemplateKey = (typeof BRAND_TEMPLATE_KEYS)[number];

/** UUID-shaped deterministic id: a replay of the same application can only ever target one store. */
export function deterministicStoreId(applicationId: string): string {
  const h = createHash("sha256").update(`z-outlet.store.from-application:${applicationId}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

/** casefold + Arabic letter folding + diacritics and punctuation strip (spec decision 7). */
export function normalizeBrandName(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[آأإ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

const RESERVED_SLUGS: ReadonlySet<string> = new Set(["admin", "api", "app", "seller", "stores", "store", "support", "www", "z-outlet"]);

/** Latin slug from a brand name. Arabic-only names have no safe transliteration here: fall back to a short id. */
export function baseSlug(brandName: string, hint: string | null | undefined, applicationId: string): string {
  const fromHint = hint ?? "";
  const latin = brandName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
  const chosen = fromHint !== "" ? fromHint : latin;
  const fallback = `brand-${applicationId.replaceAll("-", "").slice(-8)}`;
  const slug = chosen === "" ? fallback : chosen;
  return RESERVED_SLUGS.has(slug) ? `${slug}-store` : slug;
}

/** First free slug: `base`, `base-2`, `base-3`... Never overwrites an existing one. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10_000; n += 1) {
    const candidate = `${base.slice(0, 55)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error("no free slug");
}
