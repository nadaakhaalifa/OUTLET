import { z } from "zod";
import type { EmailProvider, ProviderMessage, ProviderResult } from "../../../modules/notifications";
import type { SuppressionReason } from "../../../modules/notifications/domain/types";
import { call, parseOrDrift, RejectedByProviderError, safeEqual, toProviderResult, type HttpDeps } from "./core";

/**
 * Postmark-style transactional email adapter. HAND-AUTHORED from Postmark's public API docs.
 * VERIFY BEFORE LAUNCH: endpoints, ErrorCode 300/406, MessageStream names, bounce Type values,
 * webhook authentication (basic auth or custom header) and that Arabic UTF-8 subjects render.
 * An SES adapter must pass the same conformance suite.
 */
const VENDOR = "email_postmark";
export const POSTMARK_BASE = "https://api.postmarkapp.com";

export interface EmailConfig {
  readonly serverToken: string;
  readonly from: string;
  readonly messageStream: string;
  readonly baseUrl?: string | undefined;
}

const sendResponse = z.object({ ErrorCode: z.number(), Message: z.string().optional(), MessageID: z.string().optional() }).passthrough();
const INVALID_RECIPIENT = new Set([300, 406, 405]);

export class PostmarkEmailProvider implements EmailProvider {
  readonly code = VENDOR;
  readonly channel = "email" as const;
  constructor(
    private readonly cfg: EmailConfig,
    private readonly http: HttpDeps,
  ) {}

  async send(message: ProviderMessage & { readonly channel: "email" }): Promise<ProviderResult> {
    try {
      return { kind: "sent", providerRef: await this.sendEmail(message) };
    } catch (e) {
      return toProviderResult(e);
    }
  }

  private async sendEmail(m: ProviderMessage): Promise<string> {
    const templated = m.providerTemplateId !== null;
    const payload = templated
      ? { From: this.cfg.from, To: m.to, TemplateAlias: m.providerTemplateId, TemplateModel: { subject: m.subject ?? "", body: m.body, locale: m.locale }, MessageStream: this.cfg.messageStream, Metadata: { request_id: m.requestId } }
      : { From: this.cfg.from, To: m.to, Subject: m.subject ?? "", TextBody: m.body, MessageStream: this.cfg.messageStream, Metadata: { request_id: m.requestId } };
    const res = await call(this.http, {
      vendor: VENDOR,
      operation: templated ? "send_template" : "send",
      url: `${this.cfg.baseUrl ?? POSTMARK_BASE}${templated ? "/email/withTemplate" : "/email"}`,
      method: "POST",
      headers: { "X-Postmark-Server-Token": this.cfg.serverToken, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      requestId: m.requestId,
      retry: "none", // no idempotency key in the public API
    });
    const parsed = z.object({ ErrorCode: z.number().optional() }).passthrough().safeParse(res.json);
    const errorCode = parsed.success ? parsed.data.ErrorCode : undefined;
    if (res.status >= 400) {
      throw new RejectedByProviderError(
        VENDOR,
        "send",
        errorCode !== undefined && INVALID_RECIPIENT.has(errorCode) ? "invalid_recipient" : errorCode === 1101 || errorCode === 1105 ? "template_rejected" : "other",
        String(errorCode ?? res.status),
      );
    }
    const ok = parseOrDrift(sendResponse, res.json, VENDOR, "send");
    if (ok.ErrorCode !== 0 || ok.MessageID === undefined) throw new RejectedByProviderError(VENDOR, "send", "other", String(ok.ErrorCode));
    return ok.MessageID;
  }
}

// ---- bounce / complaint webhook ------------------------------------------------------------------

/** Composition implements this over the notifications suppression store (address to user lookup, then `add`). */
export interface EmailSuppressionSink {
  suppress(address: string, reason: SuppressionReason, atMs: number): Promise<void>;
}

const webhookBody = z.discriminatedUnion("RecordType", [
  z.object({ RecordType: z.literal("Bounce"), Type: z.string(), Email: z.string().min(3) }).passthrough(),
  z.object({ RecordType: z.literal("SpamComplaint"), Email: z.string().min(3) }).passthrough(),
  z.object({ RecordType: z.literal("SubscriptionChange"), Recipient: z.string().min(3), SuppressSending: z.boolean() }).passthrough(),
]);
const HARD_BOUNCES = new Set(["HardBounce", "BadEmailAddress", "ManuallyDeactivated", "SMTPApiError", "Blocked"]);

/** Constant-time check of the shared secret sent in the webhook's authorization header. */
export function verifyEmailWebhookSecret(expected: string, header: string | undefined): boolean {
  return header !== undefined && safeEqual(expected, header);
}

/** Records a suppression for hard bounces, complaints and unsubscribes. Transient bounces are ignored. Null on drift. */
export async function handleEmailWebhook(body: unknown, sink: EmailSuppressionSink, nowMs: number): Promise<{ readonly recorded: SuppressionReason | null } | null> {
  const r = webhookBody.safeParse(body);
  if (!r.success) return null;
  const e = r.data;
  if (e.RecordType === "Bounce") {
    if (!HARD_BOUNCES.has(e.Type)) return { recorded: null };
    await sink.suppress(e.Email, "BOUNCE", nowMs);
    return { recorded: "BOUNCE" };
  }
  if (e.RecordType === "SpamComplaint") {
    await sink.suppress(e.Email, "COMPLAINT", nowMs);
    return { recorded: "COMPLAINT" };
  }
  if (!e.SuppressSending) return { recorded: null };
  await sink.suppress(e.Recipient, "UNSUBSCRIBED", nowMs);
  return { recorded: "UNSUBSCRIBED" };
}
