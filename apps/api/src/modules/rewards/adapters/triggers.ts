import { z } from "zod";
import type { RewardTrigger } from "../application/triggers";

const Id = z.string().min(1).max(200);
const Uuid = z.uuid();
const Big = z.string().regex(/^\d{1,18}$/).transform((s) => BigInt(s));
const Ms = z.number().int().nonnegative();

/**
 * Outbox payload contracts the rewards consumer accepts (snake_case, bigint as string). The
 * `review.reward_intent` and `referral.reward_earned` shapes are what reviews and referrals emit
 * today; `order.closed`, `order.refunded`, `profile.completed` and `fit.feedback_submitted` are the
 * contracts rewards needs from orders, refunds and sizing (listed under needs).
 */
export const TriggerEnvelope = z.discriminatedUnion("event_type", [
  z.object({
    event_type: z.literal("order.closed"),
    payload: z.object({ user_id: Uuid, order_ref: Id, net_merchandise: Big, delivered_at_ms: Ms }).strict(),
  }),
  z.object({
    event_type: z.literal("order.refunded"),
    payload: z
      .object({
        user_id: Uuid,
        order_ref: Id,
        refund_ref: Id,
        order_net_merchandise: Big,
        refunded_net_merchandise: Big,
        cumulative_refunded: Big,
      })
      .strict(),
  }),
  z.object({
    event_type: z.literal("review.reward_intent"),
    payload: z
      .object({
        review_id: Uuid,
        user_id: Uuid,
        order_line_id: Uuid,
        kind: z.literal("review_coins"),
        has_photo: z.boolean(),
        has_fit_info: z.boolean(),
        idempotency_key: Id,
      })
      .strict(),
  }),
  z.object({
    event_type: z.literal("profile.completed"),
    payload: z.object({ user_id: Uuid, profile_id: Id }).strict(),
  }),
  z.object({
    event_type: z.literal("fit.feedback_submitted"),
    payload: z.object({ user_id: Uuid, order_line_id: Id }).strict(),
  }),
  z.object({
    event_type: z.literal("referral.reward_earned"),
    payload: z
      .object({
        referral_id: Id,
        beneficiary_user_id: Uuid,
        amount: Big,
        currency: z.literal("EGP"),
        kind: z.literal("referral_credit"),
        idempotency_key: Id,
      })
      .strict(),
  }),
]);

export type ParsedTrigger = { readonly kind: "ok"; readonly trigger: RewardTrigger } | { readonly kind: "ignored" } | { readonly kind: "invalid" };

const KNOWN = new Set(["order.closed", "order.refunded", "review.reward_intent", "profile.completed", "fit.feedback_submitted", "referral.reward_earned"]);

/** Parses one outbox row. Unknown event types are ignored (not an error); malformed known types are invalid. */
export function parseTrigger(eventType: string, payload: unknown): ParsedTrigger {
  if (!KNOWN.has(eventType)) return { kind: "ignored" };
  const r = TriggerEnvelope.safeParse({ event_type: eventType, payload });
  if (!r.success) return { kind: "invalid" };
  const e = r.data;
  switch (e.event_type) {
    case "order.closed":
      return { kind: "ok", trigger: { type: "order.closed", userId: e.payload.user_id, orderRef: e.payload.order_ref, netMerchandise: e.payload.net_merchandise, deliveredAtMs: e.payload.delivered_at_ms } };
    case "order.refunded":
      return {
        kind: "ok",
        trigger: {
          type: "order.refunded",
          userId: e.payload.user_id,
          orderRef: e.payload.order_ref,
          refundRef: e.payload.refund_ref,
          orderNetMerchandise: e.payload.order_net_merchandise,
          refundedNetMerchandise: e.payload.refunded_net_merchandise,
          cumulativeRefunded: e.payload.cumulative_refunded,
        },
      };
    case "review.reward_intent":
      return { kind: "ok", trigger: { type: "review.reward_intent", userId: e.payload.user_id, reviewId: e.payload.review_id, hasPhoto: e.payload.has_photo, hasFitInfo: e.payload.has_fit_info } };
    case "profile.completed":
      return { kind: "ok", trigger: { type: "profile.completed", userId: e.payload.user_id, profileId: e.payload.profile_id } };
    case "fit.feedback_submitted":
      return { kind: "ok", trigger: { type: "fit.feedback_submitted", userId: e.payload.user_id, orderLineId: e.payload.order_line_id } };
    case "referral.reward_earned":
      return {
        kind: "ok",
        trigger: {
          type: "referral.reward_earned",
          userId: e.payload.beneficiary_user_id,
          referralId: e.payload.referral_id,
          amountPiastres: e.payload.amount,
          idempotencyKey: e.payload.idempotency_key,
        },
      };
  }
}
