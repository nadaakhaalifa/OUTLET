import { z } from "zod";
import type { OtpSender, OtpSendRequest, OtpSendResult } from "@outlet/auth-core";
import type { ProviderMessage, ProviderResult, SmsProvider } from "../../../modules/notifications";
import { ProviderDriftError, ProviderNotConfiguredError, ProviderUnavailableError, basicAuth, call, hmacBase64, parseOrDrift, RejectedByProviderError, safeEqual, toProviderResult, type HttpDeps } from "./core";

/**
 * Twilio-style SMS adapter (Messages and Verify). HAND-AUTHORED from Twilio's public REST docs.
 * VERIFY BEFORE LAUNCH: base URLs, form field names, the I-Twilio-Idempotency-Token header, error
 * codes 21211/21614/21610, the X-Twilio-Signature algorithm, and Egyptian sender-id registration.
 * The same class serves "provider B" through a different base URL and credentials (any
 * Twilio-compatible REST API); vendor choice is the owner's call (ADR-0034).
 */

export interface SmsDestinationPolicy {
  /** E.164 prefixes allowed as destinations. Default ["+20"] (spec s1: EG only at launch). */
  readonly allowedPrefixes: readonly string[];
}
/** Per-prefix spend cap hook (SMS pumping protection). Returns false when the prefix budget is spent. */
export interface PrefixBudget {
  tryConsume(prefix: string, atMs: number): Promise<boolean>;
}

const E164 = /^\+[1-9]\d{7,14}$/;

/** Runs BEFORE any network call. Throws RejectedByProviderError("destination_not_allowed" | "invalid_recipient"). */
export function assertDestinationAllowed(vendor: string, phone: string, policy: SmsDestinationPolicy): void {
  if (!E164.test(phone)) throw new RejectedByProviderError(vendor, "send", "invalid_recipient", "not_e164");
  if (!policy.allowedPrefixes.some((p) => phone.startsWith(p))) throw new RejectedByProviderError(vendor, "send", "destination_not_allowed", "country");
}
/** Budget bucket: country code plus the next two digits, e.g. "+2010". */
export const budgetPrefix = (phone: string): string => phone.slice(0, 5);

export interface TwilioStyleConfig {
  readonly vendor: string;
  readonly baseUrl: string;
  readonly verifyBaseUrl: string;
  readonly accountSid: string;
  readonly authToken: string;
  /** Exactly one of these is set. */
  readonly from?: string | undefined;
  readonly messagingServiceSid?: string | undefined;
  readonly verifyServiceSid?: string | undefined;
  readonly statusCallbackUrl?: string | undefined;
}

const messageResponse = z.object({ sid: z.string().min(1), status: z.string().min(1) }).passthrough();
const errorBody = z.object({ code: z.number().optional(), message: z.string().optional() }).passthrough();
const verifyResponse = z.object({ sid: z.string().min(1), status: z.string().min(1) }).passthrough();

const INVALID_RECIPIENT_CODES = new Set([21211, 21214, 21614, 21610, 21408]);

export interface TwilioStyleDeps {
  readonly http: HttpDeps;
  readonly policy: SmsDestinationPolicy;
  readonly budget: PrefixBudget | null;
  readonly nowMs: () => number;
}

export class TwilioStyleSmsProvider implements SmsProvider {
  readonly channel = "sms" as const;
  constructor(
    private readonly cfg: TwilioStyleConfig,
    private readonly d: TwilioStyleDeps,
  ) {}
  get code(): string {
    return this.cfg.vendor;
  }

  private auth(): Record<string, string> {
    return { Authorization: basicAuth(this.cfg.accountSid, this.cfg.authToken), "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  }

  private async guard(phone: string): Promise<void> {
    assertDestinationAllowed(this.cfg.vendor, phone, this.d.policy);
    if (this.d.budget !== null && !(await this.d.budget.tryConsume(budgetPrefix(phone), this.d.nowMs()))) {
      throw new RejectedByProviderError(this.cfg.vendor, "send", "budget_exceeded", "prefix_budget");
    }
  }

  /** Throws typed errors. `idempotencyKey` is sent as the vendor idempotency token. */
  async sendText(to: string, body: string, idempotencyKey: string): Promise<string> {
    await this.guard(to);
    const form = new URLSearchParams({ To: to, Body: body });
    if (this.cfg.messagingServiceSid !== undefined) form.set("MessagingServiceSid", this.cfg.messagingServiceSid);
    else if (this.cfg.from !== undefined) form.set("From", this.cfg.from);
    if (this.cfg.statusCallbackUrl !== undefined) form.set("StatusCallback", this.cfg.statusCallbackUrl);
    const res = await call(this.d.http, {
      vendor: this.cfg.vendor,
      operation: "send",
      url: `${this.cfg.baseUrl}/2010-04-01/Accounts/${this.cfg.accountSid}/Messages.json`,
      method: "POST",
      headers: { ...this.auth(), "I-Twilio-Idempotency-Token": idempotencyKey },
      body: form.toString(),
      requestId: idempotencyKey,
      retry: "none", // idempotency header behaviour is unverified
    });
    if (res.status >= 400) this.reject(res.json, res.status);
    return parseOrDrift(messageResponse, res.json, this.cfg.vendor, "send").sid;
  }

  private reject(json: unknown, status: number): never {
    const b = errorBody.safeParse(json);
    const code = b.success ? b.data.code : undefined;
    const recipientBad = code !== undefined && INVALID_RECIPIENT_CODES.has(code);
    throw new RejectedByProviderError(this.cfg.vendor, "send", recipientBad ? "invalid_recipient" : "other", String(code ?? status));
  }

  async send(message: ProviderMessage & { readonly channel: "sms" }): Promise<ProviderResult> {
    try {
      return { kind: "sent", providerRef: await this.sendText(message.to, message.body, message.requestId) };
    } catch (e) {
      return toProviderResult(e);
    }
  }

  /** Optional Twilio Verify flow (vendor generates and checks the code). Not used by the default OTP path. */
  async startVerification(to: string): Promise<string> {
    if (this.cfg.verifyServiceSid === undefined) throw new RejectedByProviderError(this.cfg.vendor, "verify", "other", "verify_not_configured");
    await this.guard(to);
    const res = await call(this.d.http, {
      vendor: this.cfg.vendor,
      operation: "verify_start",
      url: `${this.cfg.verifyBaseUrl}/v2/Services/${this.cfg.verifyServiceSid}/Verifications`,
      method: "POST",
      headers: this.auth(),
      body: new URLSearchParams({ To: to, Channel: "sms" }).toString(),
      retry: "none",
    });
    if (res.status >= 400) this.reject(res.json, res.status);
    return parseOrDrift(verifyResponse, res.json, this.cfg.vendor, "verify_start").sid;
  }
  async checkVerification(to: string, code: string): Promise<boolean> {
    if (this.cfg.verifyServiceSid === undefined) throw new RejectedByProviderError(this.cfg.vendor, "verify", "other", "verify_not_configured");
    assertDestinationAllowed(this.cfg.vendor, to, this.d.policy);
    const res = await call(this.d.http, {
      vendor: this.cfg.vendor,
      operation: "verify_check",
      url: `${this.cfg.verifyBaseUrl}/v2/Services/${this.cfg.verifyServiceSid}/VerificationCheck`,
      method: "POST",
      headers: this.auth(),
      body: new URLSearchParams({ To: to, Code: code }).toString(),
      retry: "safe", // a check is read-like
    });
    if (res.status === 404) return false;
    if (res.status >= 400) this.reject(res.json, res.status);
    return parseOrDrift(verifyResponse, res.json, this.cfg.vendor, "verify_check").status === "approved";
  }
}

// ---- OTP delivery over the auth module's port ---------------------------------------------

export function otpText(code: string, locale: "ar" | "en"): string {
  return locale === "ar" ? `رمز التحقق الخاص بك هو ${code}. لا تشاركه مع أحد.` : `Your verification code is ${code}. Do not share it with anyone.`;
}

/** Shared mapping from typed errors to the auth port's result. The code and phone are never in `reason`. */
export function toOtpResult(e: unknown): OtpSendResult {
  if (e instanceof RejectedByProviderError) return { ok: false, retryable: false, reason: `rejected_${e.rejection}` };
  if (e instanceof ProviderUnavailableError) return { ok: false, retryable: true, reason: "provider_unavailable" };
  if (e instanceof ProviderDriftError) return { ok: false, retryable: false, reason: "provider_drift" };
  if (e instanceof ProviderNotConfiguredError) return { ok: false, retryable: false, reason: "provider_not_configured" };
  throw e;
}

export class SmsOtpSender implements OtpSender {
  readonly channel = "sms" as const;
  constructor(private readonly provider: TwilioStyleSmsProvider) {}
  get id(): string {
    return `otp-${this.provider.code}`;
  }
  async send(request: OtpSendRequest): Promise<OtpSendResult> {
    try {
      return { ok: true, providerMessageId: await this.provider.sendText(request.phoneE164, otpText(request.code, request.locale), request.idempotencyKey) };
    } catch (e) {
      return toOtpResult(e);
    }
  }
}

// ---- delivery status webhook ----------------------------------------------------------------

/**
 * Twilio-style signature: base64(HMAC-SHA1(authToken, fullUrl + sorted(key+value of POST params))).
 * VERIFY BEFORE LAUNCH against the vendor's current algorithm and URL canonicalisation.
 */
export function verifySmsStatusSignature(authToken: string, fullUrl: string, params: Readonly<Record<string, string>>, signature: string | undefined): boolean {
  if (signature === undefined || signature === "") return false;
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + (params[k] ?? ""), fullUrl);
  return safeEqual(hmacBase64("sha1", authToken, data), signature);
}

export interface SmsStatusEvent {
  readonly providerRef: string;
  readonly status: "queued" | "sent" | "delivered" | "undelivered" | "failed" | "other";
  readonly errorCode: string | null;
}
const statusParams = z.object({ MessageSid: z.string().min(1), MessageStatus: z.string().min(1), ErrorCode: z.string().optional() });
export function parseSmsStatus(params: Readonly<Record<string, string>>): SmsStatusEvent | null {
  const r = statusParams.safeParse(params);
  if (!r.success) return null;
  const s = r.data.MessageStatus;
  const status = s === "queued" || s === "sent" || s === "delivered" || s === "undelivered" || s === "failed" ? s : "other";
  return { providerRef: r.data.MessageSid, status, errorCode: r.data.ErrorCode ?? null };
}
