import { z } from "zod";
import { code, minorUnits, opaqueId, paymentMethod, refundRoute, smallCount, unitInterval, positiveQuantity } from "./fields";
import { assertDomainEventName, assertPropertyName } from "./naming";
import type { AnalyticsEventName } from "./analytics-events";
import type { OwnerModule } from "./modules";
import { consentPurposeSchema } from "./purposes";
import type { PiiClass } from "./pii";
import type { RetentionPolicyId } from "./retention";

/**
 * Domain (outbox) events. These are internal, at-least-once, written in the same transaction as the
 * state change (spec §A2.7). They are NOT analytics events: they never reach the analytics transport.
 * Unlike analytics properties, an outbox payload may carry P2 (spec: "P0-P2 only, no P3"), and only the
 * P2 a consumer needs. P3 is not assignable, so a sensitive field cannot be declared here.
 *
 * Payload shapes are PROPOSED: the spec names the events and a few arguments; everything else is an
 * engineering proposal to be reconciled with each module's spec when the backend skeleton lands.
 */
type DomainFieldClasses<S extends z.ZodRawShape> = { readonly [K in keyof S]: Exclude<PiiClass, "P3"> };

interface DomainDefinition<S extends z.ZodRawShape> {
  readonly aggregate: string;
  readonly owner: OwnerModule;
  /** Outbox `event_version`. Bump on any breaking payload change. */
  readonly version: number;
  readonly description: string;
  readonly specRef: string;
  /** Retention of the business record the event describes (the outbox row itself is `outbox_published_30d_verify`). */
  readonly recordRetention: RetentionPolicyId;
  /** The pseudonymous analytics event mirrored from this one, if any. The mirror carries no P2. */
  readonly analyticsMirror?: AnalyticsEventName;
  readonly shape: S;
  readonly classes: DomainFieldClasses<S>;
}

function defineDomainEvent<const N extends string, S extends z.ZodRawShape>(name: N, def: DomainDefinition<S>) {
  assertDomainEventName(name);
  for (const key of Object.keys(def.shape)) assertPropertyName(key);
  const order: readonly PiiClass[] = ["P0", "P1", "P2"];
  const piiClass = Object.values<PiiClass>(def.classes).reduce<PiiClass>(
    (max, c) => (order.indexOf(c) > order.indexOf(max) ? c : max),
    "P0",
  );
  return {
    name,
    ...def,
    piiClass,
    /** Consent purpose needed to process the event: internal service events are necessary for the contract, security or legal duty. */
    purpose: "strictly_necessary" as const,
    outboxRetention: "outbox_published_30d_verify" as RetentionPolicyId,
    schema: z.strictObject(def.shape),
  };
}

const instant = z.iso.datetime();
const userId = opaqueId; // P2: a user identifier is personal data (docs/privacy/data_inventory.yaml convention).

export const domainEvents = {
  "user.registered": defineDomainEvent("user.registered", {
    aggregate: "user", owner: "identity", version: 1, specRef: "§1", recordRetention: "account_lifetime_verify",
    description: "An account was created after OTP/Apple/Google/passkey sign-in.",
    shape: { user_id: userId, auth_method: z.enum(["phone_otp", "apple", "google", "passkey"]), locale: z.enum(["ar", "en"]) },
    classes: { user_id: "P2", auth_method: "P1", locale: "P1" },
  }),
  "user.age_blocked": defineDomainEvent("user.age_blocked", {
    aggregate: "age_gate", owner: "identity", version: 1, specRef: "§1, §B6", recordRetention: "operational_proposed_verify",
    description: "A sign-up was blocked by the 18+ gate. Carries no date of birth and no user id: the person may not have an account.",
    shape: { attempt_id: opaqueId, reason: z.literal("under_18") },
    classes: { attempt_id: "P1", reason: "P1" },
  }),
  "consent.changed": defineDomainEvent("consent.changed", {
    aggregate: "consent", owner: "privacy", version: 1, specRef: "§1, §B1", recordRetention: "legal_proof_verify",
    analyticsMirror: "consent_changed",
    description: "A consent purpose was granted or withdrawn. Fires on withdrawal too.",
    shape: { user_id: userId, purpose: consentPurposeSchema, granted: z.boolean(), consent_version: code, method: code },
    classes: { user_id: "P2", purpose: "P1", granted: "P1", consent_version: "P1", method: "P1" },
  }),
  "session.revoked": defineDomainEvent("session.revoked", {
    aggregate: "session", owner: "identity", version: 1, specRef: "§1", recordRetention: "operational_proposed_verify",
    description: "A session or refresh-token family was revoked.",
    shape: { user_id: userId, session_id: opaqueId, reason: z.enum(["logout", "user_revoked", "security_event", "account_deleted"]) },
    classes: { user_id: "P2", session_id: "P1", reason: "P1" },
  }),
  "privacy.deletion_requested": defineDomainEvent("privacy.deletion_requested", {
    aggregate: "privacy_request", owner: "privacy", version: 1, specRef: "§2", recordRetention: "legal_proof_verify",
    description: "An account deletion was requested; the 14-day cooling period starts.",
    shape: { user_id: userId, request_id: opaqueId, cooling_off_ends_at: instant },
    classes: { user_id: "P2", request_id: "P1", cooling_off_ends_at: "P1" },
  }),
  "privacy.deletion_completed": defineDomainEvent("privacy.deletion_completed", {
    aggregate: "privacy_request", owner: "privacy", version: 1, specRef: "§2", recordRetention: "legal_proof_verify",
    description: "PII was erased or pseudonymised. Keyed by request id only, because the user id is gone.",
    shape: { request_id: opaqueId, completed_at: instant },
    classes: { request_id: "P1", completed_at: "P1" },
  }),
  "privacy.export_ready": defineDomainEvent("privacy.export_ready", {
    aggregate: "privacy_request", owner: "privacy", version: 1, specRef: "§2, §B1", recordRetention: "legal_proof_verify",
    description: "A data export is ready. The signed URL is never in the event.",
    shape: { user_id: userId, request_id: opaqueId, expires_at: instant },
    classes: { user_id: "P2", request_id: "P1", expires_at: "P1" },
  }),
  "cart.line_unavailable": defineDomainEvent("cart.line_unavailable", {
    aggregate: "cart", owner: "bag", version: 1, specRef: "§6", recordRetention: "operational_proposed_verify",
    description: "A bag line became unavailable (stock and price are rechecked from Postgres).",
    shape: { user_id: userId, cart_id: opaqueId, sku_id: opaqueId, reason: z.enum(["sold_out", "delisted", "store_paused"]) },
    classes: { user_id: "P2", cart_id: "P1", sku_id: "P1", reason: "P1" },
  }),
  "order_group.placed": defineDomainEvent("order_group.placed", {
    aggregate: "order_group", owner: "checkout", version: 1, specRef: "§7", recordRetention: "financial_tax_period_verify",
    analyticsMirror: "order_placed",
    description: "An order group was placed (before payment for non-COD methods).",
    shape: {
      order_group_id: opaqueId, user_id: userId, seller_order_count: smallCount, line_count: smallCount,
      total_minor: minorUnits, payment_method: paymentMethod,
    },
    classes: { order_group_id: "P1", user_id: "P2", seller_order_count: "P1", line_count: "P1", total_minor: "P1", payment_method: "P1" },
  }),
  "order_group.paid": defineDomainEvent("order_group.paid", {
    aggregate: "order_group", owner: "checkout", version: 1, specRef: "§7", recordRetention: "financial_tax_period_verify",
    description: "Payment succeeded (HMAC-verified PSP webhook, deduplicated by PSP event id); seller orders become PAID.",
    shape: { order_group_id: opaqueId, total_minor: minorUnits, payment_method: paymentMethod },
    classes: { order_group_id: "P1", total_minor: "P1", payment_method: "P1" },
  }),
  "order_group.failed": defineDomainEvent("order_group.failed", {
    aggregate: "order_group", owner: "checkout", version: 1, specRef: "§7", recordRetention: "financial_tax_period_verify",
    description: "Payment failed or expired.",
    shape: { order_group_id: opaqueId, failure_code: code },
    classes: { order_group_id: "P1", failure_code: "P1" },
  }),
  "inventory.reserved": defineDomainEvent("inventory.reserved", {
    aggregate: "reservation", owner: "inventory", version: 1, specRef: "§7, §20.2", recordRetention: "operational_proposed_verify",
    description: "Units were reserved with a TTL for a checkout.",
    shape: { reservation_id: opaqueId, sku_id: opaqueId, quantity: positiveQuantity, expires_at: instant },
    classes: { reservation_id: "P1", sku_id: "P1", quantity: "P1", expires_at: "P1" },
  }),
  "inventory.claimed": defineDomainEvent("inventory.claimed", {
    aggregate: "reservation", owner: "inventory", version: 1, specRef: "§7, §20.2", recordRetention: "operational_proposed_verify",
    description: "Reserved units were claimed on payment, in the same transaction as the ledger post.",
    shape: { reservation_id: opaqueId, sku_id: opaqueId, quantity: positiveQuantity, order_group_id: opaqueId },
    classes: { reservation_id: "P1", sku_id: "P1", quantity: "P1", order_group_id: "P1" },
  }),
  "inventory.released": defineDomainEvent("inventory.released", {
    aggregate: "reservation", owner: "inventory", version: 1, specRef: "§7, §20.2", recordRetention: "operational_proposed_verify",
    description: "Reserved units went back to stock.",
    shape: { reservation_id: opaqueId, sku_id: opaqueId, quantity: positiveQuantity, reason: z.enum(["expired", "cancelled", "payment_failed", "manual"]) },
    classes: { reservation_id: "P1", sku_id: "P1", quantity: "P1", reason: "P1" },
  }),
  "price.changed": defineDomainEvent("price.changed", {
    aggregate: "sku_price", owner: "price-integrity", version: 1, specRef: "§9.7", recordRetention: "operational_proposed_verify",
    description: "An immutable price event was appended; low_30d is refreshed from it.",
    shape: { sku_id: opaqueId, store_id: opaqueId, price_minor: minorUnits, source: code },
    classes: { sku_id: "P1", store_id: "P1", price_minor: "P0", source: "P1" },
  }),
  "price_claim.scored": defineDomainEvent("price_claim.scored", {
    aggregate: "price_claim", owner: "price-integrity", version: 1, specRef: "§9.7", recordRetention: "operational_proposed_verify",
    description: "A reference-price claim was scored.",
    shape: { claim_id: opaqueId, sku_id: opaqueId, trust_score: unitInterval, status: code },
    classes: { claim_id: "P1", sku_id: "P1", trust_score: "P1", status: "P1" },
  }),
  "price_enforcement.applied": defineDomainEvent("price_enforcement.applied", {
    aggregate: "enforcement_action", owner: "price-integrity", version: 1, specRef: "§9.5, §9.7", recordRetention: "operational_proposed_verify",
    description: "An automatic enforcement-ladder action was applied to a store or SKU.",
    shape: { action_id: opaqueId, store_id: opaqueId, sku_id: opaqueId.optional(), action: code },
    classes: { action_id: "P1", store_id: "P1", sku_id: "P1", action: "P1" },
  }),
  "channel_snapshot.ingested": defineDomainEvent("channel_snapshot.ingested", {
    aggregate: "channel_snapshot", owner: "price-integrity", version: 1, specRef: "§9.7", recordRetention: "operational_proposed_verify",
    description: "A seller channel snapshot was ingested (seller-consented monitoring).",
    shape: { snapshot_id: opaqueId, store_id: opaqueId, channel: code, item_count: smallCount },
    classes: { snapshot_id: "P1", store_id: "P1", channel: "P1", item_count: "P1" },
  }),
  "return.received": defineDomainEvent("return.received", {
    aggregate: "return", owner: "returns", version: 1, specRef: "§22", recordRetention: "financial_tax_period_verify",
    description: "A returned parcel was received.",
    shape: { return_id: opaqueId, seller_order_id: opaqueId },
    classes: { return_id: "P1", seller_order_id: "P1" },
  }),
  "return.inspected": defineDomainEvent("return.inspected", {
    aggregate: "return", owner: "returns", version: 1, specRef: "§22", recordRetention: "financial_tax_period_verify",
    description: "A returned parcel was inspected (proposed result values).",
    shape: { return_id: opaqueId, result: z.enum(["accepted", "rejected", "partial"]) },
    classes: { return_id: "P1", result: "P1" },
  }),
  "refund.completed": defineDomainEvent("refund.completed", {
    aggregate: "refund", owner: "refunds", version: 1, specRef: "§15.6, §22", recordRetention: "financial_tax_period_verify",
    analyticsMirror: "refund_completed",
    description: "A refund reached its destination.",
    shape: { refund_id: opaqueId, user_id: userId, order_group_id: opaqueId, route: refundRoute, amount_minor: minorUnits },
    classes: { refund_id: "P1", user_id: "P2", order_group_id: "P1", route: "P1", amount_minor: "P1" },
  }),
} as const;

export type DomainEventCatalog = typeof domainEvents;
export type DomainEventName = keyof DomainEventCatalog;
export type DomainEventPayload<N extends DomainEventName> = z.output<DomainEventCatalog[N]["schema"]>;
export const DOMAIN_EVENT_NAMES = Object.keys(domainEvents) as DomainEventName[];

export function isDomainEventName(name: unknown): name is DomainEventName {
  return typeof name === "string" && Object.hasOwn(domainEvents, name);
}
