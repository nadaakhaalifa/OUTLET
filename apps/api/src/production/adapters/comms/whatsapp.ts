import { z } from "zod";
import type { OtpSender, OtpSendRequest, OtpSendResult } from "@outlet/auth-core";
import type { ProviderMessage, ProviderResult, WhatsAppProvider } from "../../../modules/notifications";
import { call, hmacHex, parseOrDrift, RejectedByProviderError, safeEqual, toProviderResult, type HttpDeps } from "./core";
import { toOtpResult } from "./sms";

/**
 * WhatsApp Business Cloud API adapter (template messages only). HAND-AUTHORED from Meta's public
 * docs. VERIFY BEFORE LAUNCH: Graph API version, payload shape, error codes 131026/131030/132000/
 * 132001/130429, X-Hub-Signature-256 verification, the authentication-template button parameter,
 * and template approval per language. Marketing consent is decided by the notifications policy
 * before this adapter is called; it only ever sends approved templates.
 */
const VENDOR = "wa_cloud";
export const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export interface WhatsAppConfig {
  readonly phoneNumberId: string;
  readonly accessToken: string;
  readonly appSecret: string;
  /** Approved authentication template used for OTP delivery (AR and EN variants share the name). */
  readonly otpTemplate?: string | undefined;
  readonly baseUrl?: string | undefined;
}

const sendResponse = z.object({ messages: z.array(z.object({ id: z.string().min(1) }).passthrough()).min(1) }).passthrough();
const errorBody = z.object({ error: z.object({ code: z.number().optional() }).passthrough() }).passthrough();

const RECIPIENT_CODES = new Set([131026, 131030, 131021]);
const TEMPLATE_CODES = new Set([132000, 132001, 132005, 132007, 132012, 132015, 132016]);

export interface TemplateSend {
  readonly to: string;
  readonly templateName: string;
  readonly locale: "ar" | "en";
  readonly variables: readonly string[];
  /** Cloud API has no idempotency header; the key is carried for logs and our own dedupe. */
  readonly idempotencyKey: string;
  /** Authentication templates need the code repeated as the copy-code button parameter. */
  readonly otpButton?: string | undefined;
}

export class WhatsAppCloudProvider implements WhatsAppProvider {
  readonly code = VENDOR;
  readonly channel = "whatsapp" as const;
  constructor(
    private readonly cfg: WhatsAppConfig,
    private readonly http: HttpDeps,
  ) {}

  async sendTemplate(t: TemplateSend): Promise<string> {
    if (!/^\+[1-9]\d{7,14}$/.test(t.to)) throw new RejectedByProviderError(VENDOR, "send", "invalid_recipient", "not_e164");
    const components: unknown[] = [{ type: "body", parameters: t.variables.map((text) => ({ type: "text", text })) }];
    if (t.otpButton !== undefined) components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: t.otpButton }] });
    const res = await call(this.http, {
      vendor: VENDOR,
      operation: "send_template",
      url: `${this.cfg.baseUrl ?? GRAPH_BASE}/${this.cfg.phoneNumberId}/messages`,
      method: "POST",
      headers: { Authorization: `Bearer ${this.cfg.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: t.to.slice(1),
        type: "template",
        template: { name: t.templateName, language: { code: t.locale }, components },
      }),
      requestId: t.idempotencyKey,
      retry: "none",
    });
    if (res.status >= 400) {
      const b = errorBody.safeParse(res.json);
      const code = b.success ? b.data.error.code : undefined;
      const kind = code !== undefined && RECIPIENT_CODES.has(code) ? "invalid_recipient" : code !== undefined && TEMPLATE_CODES.has(code) ? "template_rejected" : "other";
      throw new RejectedByProviderError(VENDOR, "send_template", kind, String(code ?? res.status));
    }
    return parseOrDrift(sendResponse, res.json, VENDOR, "send_template").messages[0]?.id ?? "";
  }

  /** The dispatcher's ProviderMessage carries one body string: it becomes template variable {{1}}. */
  async send(message: ProviderMessage & { readonly channel: "whatsapp" }): Promise<ProviderResult> {
    if (message.providerTemplateId === null) return { kind: "template_rejected" };
    try {
      const ref = await this.sendTemplate({
        to: message.to,
        templateName: message.providerTemplateId,
        locale: message.locale,
        variables: [message.body],
        idempotencyKey: message.requestId,
      });
      return { kind: "sent", providerRef: ref };
    } catch (e) {
      return toProviderResult(e);
    }
  }
}

export class WhatsAppOtpSender implements OtpSender {
  readonly channel = "whatsapp" as const;
  readonly id = `otp-${VENDOR}`;
  constructor(
    private readonly provider: WhatsAppCloudProvider,
    private readonly template: string,
  ) {}
  async send(request: OtpSendRequest): Promise<OtpSendResult> {
    try {
      const id = await this.provider.sendTemplate({
        to: request.phoneE164,
        templateName: this.template,
        locale: request.locale,
        variables: [request.code],
        otpButton: request.code,
        idempotencyKey: request.idempotencyKey,
      });
      return { ok: true, providerMessageId: id };
    } catch (e) {
      return toOtpResult(e);
    }
  }
}

// ---- webhook ---------------------------------------------------------------------------------

/** `X-Hub-Signature-256: sha256=<hex HMAC-SHA256(appSecret, rawBody)>`; compared in constant time. */
export function verifyWhatsAppSignature(appSecret: string, rawBody: string, header: string | undefined): boolean {
  if (header === undefined || !header.startsWith("sha256=")) return false;
  return safeEqual(`sha256=${hmacHex("sha256", appSecret, rawBody)}`, header);
}

export interface WhatsAppStatusEvent {
  readonly providerRef: string;
  readonly status: "sent" | "delivered" | "read" | "failed";
  readonly errorCode: number | null;
}
const webhook = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          value: z.object({
            statuses: z
              .array(
                z.object({
                  id: z.string(),
                  status: z.enum(["sent", "delivered", "read", "failed"]),
                  errors: z.array(z.object({ code: z.number() }).passthrough()).optional(),
                }).passthrough(),
              )
              .optional(),
          }).passthrough(),
        }).passthrough(),
      ),
    }).passthrough(),
  ),
}).passthrough();

/** Returns null for a body that does not match (drift): the handler answers 200 only for parsed bodies. */
export function parseWhatsAppStatuses(body: unknown): readonly WhatsAppStatusEvent[] | null {
  const r = webhook.safeParse(body);
  if (!r.success) return null;
  return r.data.entry.flatMap((e) =>
    e.changes.flatMap((c) => (c.value.statuses ?? []).map((s) => ({ providerRef: s.id, status: s.status, errorCode: s.errors?.[0]?.code ?? null }))),
  );
}
