import { z } from "zod";
import type { JsonValue, ParsedWebhook } from "../domain/ports";
import { SavedCardSchema } from "../domain/schemas";
import { NORMALIZED_EVENT_KINDS } from "../domain/seam";

/** Canonical webhook body of the in-repo fake PSP. Paymob has its own recorded shape (see paymob/). */
export const FakeWebhookBodySchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(NORMALIZED_EVENT_KINDS),
      event_id: z.string().min(1).max(128),
      provider_ref: z.string().min(1).max(128).nullable(),
      order_group_id: z.uuid().nullable(),
      amount: z.string().regex(/^(0|[1-9]\d{0,17})$/),
      currency: z.string().length(3),
      occurred_at_ms: z.number().int().nonnegative(),
      failure_code: z.string().max(64).nullable().default(null),
      refund_ref: z.string().min(1).max(128).nullable().default(null),
    })
    .strict(),
  z
    .object({
      type: z.literal("card.tokenized"),
      event_id: z.string().min(1).max(128),
      user_id: z.uuid(),
      card: SavedCardSchema,
    })
    .strict(),
]);
export type FakeWebhookBody = z.infer<typeof FakeWebhookBodySchema>;

export function eventIdFromBytes(raw: Uint8Array): string | null {
  try {
    const j = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
    const r = z.object({ event_id: z.string().min(1).max(128) }).passthrough().safeParse(j);
    return r.success ? r.data.event_id : null;
  } catch {
    return null;
  }
}

export function parseFakeBody(body: JsonValue): ParsedWebhook {
  const r = FakeWebhookBodySchema.safeParse(body);
  if (!r.success) return { type: "invalid", reason: "schema" };
  const b = r.data;
  if (b.type === "card.tokenized") return { type: "card_token", eventId: b.event_id, userId: b.user_id, card: b.card };
  return {
    type: "payment",
    event: {
      eventId: b.event_id,
      kind: b.type,
      providerRef: b.provider_ref,
      orderGroupId: b.order_group_id,
      amount: BigInt(b.amount),
      currency: b.currency,
      occurredAtMs: b.occurred_at_ms,
      failureCode: b.failure_code,
      providerRefundRef: b.refund_ref,
    },
  };
}
