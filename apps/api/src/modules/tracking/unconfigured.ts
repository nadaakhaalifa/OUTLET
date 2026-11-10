import type { CourierEvent, CourierWebhookPort } from "@outlet/shipping";

/** No courier contract (V33/V43) means no secret to verify with: every callback is a bad signature and changes nothing. */
export class UnconfiguredCourierWebhook implements CourierWebhookPort {
  verify(): boolean {
    return false;
  }
  parse(): readonly CourierEvent[] {
    throw new Error("courier webhook is not configured");
  }
}
