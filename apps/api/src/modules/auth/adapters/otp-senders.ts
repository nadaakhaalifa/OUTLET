import type { OtpChannel, OtpSender, OtpSendResult } from "@outlet/auth-core";

/**
 * Production default for the SMS and WhatsApp providers until a contract exists
 * (`messaging.sms-whatsapp`). Sends nothing and says why; RequestOtp turns "every sender is
 * unconfigured" into 503 provider_not_configured. The OTP code never reaches this class's logs.
 */
export class UnconfiguredOtpSender implements OtpSender {
  constructor(readonly channel: OtpChannel) {}
  get id(): string {
    return `unconfigured-${this.channel}`;
  }
  async send(): Promise<OtpSendResult> {
    return { ok: false, retryable: false, reason: "provider_not_configured" };
  }
}
