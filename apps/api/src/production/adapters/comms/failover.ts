import type { OtpSender, OtpSendRequest, OtpSendResult } from "@outlet/auth-core";

/**
 * Pure failover over the auth module's OtpSender port (spec s1): SMS provider A, then B, then
 * WhatsApp. Moves on after a retryable failure or an unconfigured provider. Stops at the first
 * permanent refusal (bad or disallowed number, drift), because the next provider would refuse the
 * same number and trying it only widens the pumping surface. Never logs or stores the request.
 */
export class FailoverOtpSender implements OtpSender {
  readonly channel: OtpSender["channel"];
  constructor(private readonly chain: readonly [OtpSender, ...OtpSender[]]) {
    this.channel = chain[0].channel;
  }
  get id(): string {
    return `failover(${this.chain.map((s) => s.id).join(">")})`;
  }
  async send(request: OtpSendRequest): Promise<OtpSendResult> {
    let last: OtpSendResult = { ok: false, retryable: false, reason: "provider_not_configured" };
    for (const sender of this.chain) {
      let r: OtpSendResult;
      try {
        r = await sender.send(request);
      } catch {
        r = { ok: false, retryable: true, reason: "sender_threw" };
      }
      if (r.ok) return r;
      last = r;
      if (!r.retryable && r.reason !== "provider_not_configured") return r;
    }
    return last;
  }
}
