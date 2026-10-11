import { describe, expect, it } from "vitest";
import { RefundIntentEventSchema } from "../../returns";
import { RefundIntentMessageSchema } from "../domain/ports";
import { intent } from "./fixtures";

/** Consumer-side contract: the producer's schema (returns module) and ours accept each other's events. */
describe("return.refund_intent contract", () => {
  it("an event valid for the producer is valid for the consumer, and the reverse", () => {
    const msg = intent(1) as { event: unknown };
    expect(RefundIntentEventSchema.safeParse(msg.event).success).toBe(true);
    expect(RefundIntentMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("both reject an unknown field (strict) and a non-EGP currency", () => {
    const msg = intent(1) as { messageId: string; event: Record<string, unknown> };
    for (const bad of [{ ...msg.event, extra: 1 }, { ...msg.event, currency: "USD" }]) {
      expect(RefundIntentEventSchema.safeParse(bad).success).toBe(false);
      expect(RefundIntentMessageSchema.safeParse({ messageId: msg.messageId, event: bad }).success).toBe(false);
    }
  });
});
