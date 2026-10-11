import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { money, type Money } from "../domain/bridge";
import type {
  CheckoutMethod,
  ClientAction,
  CreateIntentResult,
  PaymentProviderPort,
  WebhookVerification,
} from "../domain/ports";

/**
 * Replays RECORDED provider exchanges behind PaymentProviderPort. Paymob is not contracted, so every
 * shape here is an ASSUMPTION (VERIFY BEFORE LAUNCH, rows VR-CHK-1..8): there is no live call, no
 * network client and no credentials in this file. Unrecorded operations fail loudly, never guess.
 */
const CreateFixture = z
  .object({
    operation: z.literal("create_intent"),
    idempotency_key: z.string(),
    response: z
      .object({
        intent_id: z.string(),
        action: z.enum(["redirect", "sdk", "fawry_reference", "none"]),
        url: z.string().optional(),
        token: z.string().optional(),
        reference: z.string().optional(),
        expires_at_ms: z.number().int().optional(),
        rejected_code: z.string().optional(),
      })
      .strict(),
  })
  .strict();
const VoidFixture = z
  .object({ operation: z.literal("void_intent"), intent_id: z.string(), result: z.enum(["voided", "already_voided", "not_voidable_succeeded"]) })
  .strict();
const RefundFixture = z.object({ operation: z.literal("refund"), idempotency_key: z.string() }).strict();
export const RecordedFixture = z.discriminatedUnion("operation", [CreateFixture, VoidFixture, RefundFixture]);
export type RecordedFixtureT = z.infer<typeof RecordedFixture>;

const WebhookBody = z
  .object({
    id: z.string().min(1),
    intent_id: z.string().min(1),
    order_group_id: z.string().min(1),
    status: z.enum(["succeeded", "failed"]),
    amount_piastres: z.string().regex(/^\d+$/),
    created_at_ms: z.number().int(),
  })
  .strict();

export class RecordedFixtureProvider implements PaymentProviderPort {
  constructor(
    readonly provider: string,
    private readonly fixtures: readonly RecordedFixtureT[],
    private readonly webhookSecret: string,
  ) {}

  async createIntent(input: { idempotencyKey: string; amount: Money; method: CheckoutMethod; userId: string }): Promise<CreateIntentResult> {
    const f = this.fixtures.find((x) => x.operation === "create_intent" && x.idempotency_key === input.idempotencyKey);
    if (f === undefined || f.operation !== "create_intent") throw new Error(`no recorded create_intent for ${input.idempotencyKey}`);
    const r = f.response;
    if (r.rejected_code !== undefined) return { kind: "rejected", code: r.rejected_code };
    let clientAction: ClientAction;
    switch (r.action) {
      case "redirect":
        clientAction = { type: "redirect", url: r.url ?? "" };
        break;
      case "sdk":
        clientAction = { type: "sdk", sdk: this.provider, token: r.token ?? "" };
        break;
      case "fawry_reference":
        clientAction = { type: "fawry_reference", reference: r.reference ?? "", expiresAtMs: r.expires_at_ms ?? 0 };
        break;
      case "none":
        clientAction = { type: "none" };
        break;
    }
    return { kind: "created", intentId: r.intent_id, provider: this.provider, clientAction };
  }

  async voidIntent(intentId: string): Promise<{ kind: "voided" | "already_voided" } | { kind: "not_voidable_succeeded" }> {
    const f = this.fixtures.find((x) => x.operation === "void_intent" && x.intent_id === intentId);
    if (f === undefined || f.operation !== "void_intent") throw new Error(`no recorded void_intent for ${intentId}`);
    return { kind: f.result };
  }

  async refund(input: { intentId: string; amount: Money; idempotencyKey: string }): Promise<void> {
    const f = this.fixtures.find((x) => x.operation === "refund" && x.idempotency_key === input.idempotencyKey);
    if (f === undefined) throw new Error(`no recorded refund for ${input.idempotencyKey}`);
  }

  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>, nowMs: number): WebhookVerification {
    const given = headers["x-signature"];
    const want = createHmac("sha256", this.webhookSecret).update(rawBody).digest("hex");
    if (given === undefined || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want))) {
      return { ok: false, reason: "bad_signature" };
    }
    let b: z.infer<typeof WebhookBody>;
    try {
      b = WebhookBody.parse(JSON.parse(rawBody));
    } catch {
      return { ok: false, reason: "malformed" };
    }
    if (Math.abs(nowMs - b.created_at_ms) > 5 * 60 * 1000) return { ok: false, reason: "stale_timestamp" };
    return {
      ok: true,
      event: {
        eventId: b.id,
        provider: this.provider,
        intentId: b.intent_id,
        orderGroupId: b.order_group_id,
        kind: b.status,
        amount: money(BigInt(b.amount_piastres)),
        occurredAtMs: b.created_at_ms,
      },
    };
  }
}
