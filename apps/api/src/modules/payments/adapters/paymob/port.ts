import { z } from "zod";
import type { ClientAction } from "../../domain/schemas";
import { ClientActionSchema } from "../../domain/schemas";
import type {
  CreateIntentRequest,
  CreatedIntent,
  JsonValue,
  ParsedWebhook,
  PaymentProviderPort,
  ProviderResult,
  RefundOutcome,
  RetrievedIntent,
  WebhookInput,
  WebhookVerification,
} from "../../domain/ports";
import { PAYMENT_INTENT_STATES, PAYMENT_METHOD_IDS, type PaymentMethodId } from "../../domain/seam";
import { verifyHmacWebhook, type HmacWebhookConfig } from "../hmac-webhook";
import type { PaymobHttpRequest, PaymobTransport, PaymobTransportOutcome } from "./transport";

export const PAYMOB_PROVIDER_ID = "paymob";
export const PAYMOB_SIGNATURE_HEADER = "x-paymob-signature";
export const PAYMOB_TIMESTAMP_HEADER = "x-paymob-timestamp";

export interface PaymobConfig {
  /** Public checkout URL the shopper is sent to. ASSUMPTION (VR-PAY-02). */
  readonly checkoutBaseUrl: string;
  readonly publicKey: string;
  /** Integration id per method. A method without an id is not served (VR-PAY-03). */
  readonly integrationIds: Readonly<Partial<Record<PaymentMethodId, number>>>;
  /** Newest first (rotation). ASSUMPTION: HMAC-SHA512 over `timestamp.rawBody` (VR-PAY-07). */
  readonly webhookSecrets: readonly string[];
}

// ---- response schemas: every PSP body is validated (API10), shapes are ASSUMPTIONS (VR-PAY-01) ----
const IntentionBase = z.object({
  id: z.string().min(1).max(128),
  client_secret: z.string().min(8).max(256),
  intention_order_id: z.number().int().optional(),
});
const WithApplePay = IntentionBase.extend({ apple_pay_session_url: z.url().max(2048) });
const WithRedirect = IntentionBase.extend({ redirection_url: z.url().max(2048) });
const WithQr = IntentionBase.extend({ qr_payload: z.string().min(1).max(2048) });
const WithFawry = IntentionBase.extend({
  bill_reference: z.string().min(4).max(32).regex(/^[0-9A-Za-z-]+$/),
  reference_expires_at_ms: z.number().int().positive(),
});
const ActionResult = z.object({ id: z.union([z.string(), z.number()]).transform(String), success: z.boolean(), pending: z.boolean().optional() });
const Retrieved = z.object({
  id: z.string(),
  status: z.enum(PAYMENT_INTENT_STATES),
  amount_cents: z.number().int().nonnegative(),
  currency: z.string().length(3),
  failure_code: z.string().nullable(),
});
const ErrorBody = z.object({ code: z.string().max(64).optional() }).passthrough();
const TxnCallback = z.object({
  type: z.literal("TRANSACTION"),
  obj: z.object({
    id: z.union([z.number(), z.string()]).transform(String),
    success: z.boolean(),
    pending: z.boolean(),
    is_voided: z.boolean().default(false),
    is_refunded: z.boolean().default(false),
    is_auth: z.boolean().default(false),
    is_capture: z.boolean().default(false),
    amount_cents: z.number().int().nonnegative(),
    currency: z.string().length(3),
    created_at_ms: z.number().int().nonnegative(),
    order: z.object({ id: z.union([z.number(), z.string()]).transform(String), merchant_order_id: z.uuid().nullable() }),
    data: z.object({ message: z.string().max(200).optional() }).optional(),
    parent_transaction: z.union([z.number(), z.string()]).transform(String).optional(),
  }),
});
const TokenCallback = z.object({
  type: z.literal("TOKEN"),
  obj: z.object({
    token: z.string().min(8).max(256),
    masked_pan: z.string().max(32),
    card_subtype: z.string().max(32),
    exp_month: z.number().int().min(1).max(12).optional(),
    exp_year: z.number().int().min(2000).max(2200).optional(),
    fingerprint: z.string().min(8).max(128).optional(),
    merchant_user_id: z.uuid().optional(),
  }),
});

const brandOf = (s: string): "visa" | "mastercard" | "meeza" | "amex" | "other" => {
  const l = s.toLowerCase();
  return l.includes("visa") ? "visa" : l.includes("master") ? "mastercard" : l.includes("meeza") ? "meeza" : l.includes("amex") ? "amex" : "other";
};

/**
 * PaymentProviderPort for Paymob, written ONLY against recorded-shape fixtures. It cannot reach a
 * network: all IO goes through `PaymobTransport`, and the repo ships no HTTP transport. Never
 * enable in an environment before docs/compliance/verify-register.md VR-PAY-01..12 are verified.
 */
export class PaymobPort implements PaymentProviderPort {
  readonly id = PAYMOB_PROVIDER_ID;
  readonly methods: readonly PaymentMethodId[];

  constructor(
    private readonly transport: PaymobTransport,
    private readonly cfg: PaymobConfig,
  ) {
    this.methods = PAYMENT_METHOD_IDS.filter((m) => cfg.integrationIds[m] !== undefined);
  }

  // ---- shared plumbing ----------------------------------------------------------------------
  private async call(req: PaymobHttpRequest): Promise<PaymobTransportOutcome> {
    return this.transport.send(req);
  }

  /** HTTP status to failure kind. 5xx other than gateway errors is ambiguous: never failed over. */
  private failureOf(status: number, body: unknown): ProviderResult<never> {
    const code = ErrorBody.safeParse(body);
    const c = code.success && code.data.code !== undefined ? code.data.code : `http_${status}`;
    if (status === 401 || status === 403) return { kind: "unavailable", code: "psp_auth_rejected" };
    if (status === 429) return { kind: "unavailable", code: "rate_limited" };
    if (status === 502 || status === 503 || status === 504) return { kind: "unavailable", code: `http_${status}` };
    if (status >= 500) return { kind: "invalid_response" };
    if (status === 402 || status === 422) return { kind: "declined", code: c };
    return { kind: "invalid_request", code: c };
  }

  private async simple<T>(req: PaymobHttpRequest, parse: (body: unknown) => ProviderResult<T>): Promise<ProviderResult<T>> {
    const out = await this.call(req);
    if (out.kind === "timeout") return { kind: "timeout" };
    if (out.kind === "connect_error") return { kind: "unavailable", code: "connect_error" };
    if (out.status >= 200 && out.status < 300) return parse(out.body);
    return this.failureOf(out.status, out.body);
  }

  // ---- port ---------------------------------------------------------------------------------
  async createIntent(req: CreateIntentRequest): Promise<ProviderResult<CreatedIntent>> {
    const integrationId = this.cfg.integrationIds[req.method];
    if (integrationId === undefined) return { kind: "invalid_request", code: "method_not_supported" };
    if (req.amount <= 0n || req.amount > BigInt(Number.MAX_SAFE_INTEGER)) return { kind: "invalid_request", code: "amount_out_of_range" };
    const out = await this.call({
      op: "create_intention",
      method: "POST",
      path: "/v1/intention/",
      idempotencyKey: req.idempotencyKey,
      meta: { paymentMethod: req.method },
      body: {
        amount: Number(req.amount),
        currency: req.currency,
        payment_methods: [integrationId],
        special_reference: req.orderGroupId,
        expiration_seconds: Math.max(60, Math.floor(req.expiresInMs / 1000)),
        // Minimal payer contact only; no address, no card data (SAQ A, PDPL minimisation).
        billing_data: { phone_number: req.payer.phoneE164, email: req.payer.email },
      },
    });
    if (out.kind === "timeout") return { kind: "timeout" };
    if (out.kind === "connect_error") return { kind: "unavailable", code: "connect_error" };
    if (out.status === 409) {
      // The reference exists: our earlier call (or a retry) created it. Resolve it, never re-create (VR-PAY-04).
      const existing = await this.retrieve({ providerRef: null, orderGroupId: req.orderGroupId });
      if (existing.kind !== "ok") return existing;
      if (existing.value === null) return { kind: "invalid_response" };
      return this.createdFromRetrieved(existing.value, req);
    }
    if (out.status < 200 || out.status >= 300) return this.failureOf(out.status, out.body);
    return this.mapCreated(req, out.body);
  }

  private createdFromRetrieved(r: RetrievedIntent, req: CreateIntentRequest): ProviderResult<CreatedIntent> {
    if (r.amount !== req.amount) return { kind: "invalid_request", code: "idempotency_mismatch" };
    // ASSUMPTION (VR-PAY-04): the hosted page can be re-opened with the intention id in place of the
    // client secret. If Paymob does not allow that, a conflict must surface as a retry-later instead.
    return { kind: "ok", value: { providerRef: r.providerRef, clientAction: this.hostedAction(r.providerRef), expiresAtMs: null } };
  }

  private hostedAction(clientSecret: string): ClientAction {
    const u = new URL(this.cfg.checkoutBaseUrl);
    u.searchParams.set("publicKey", this.cfg.publicKey);
    u.searchParams.set("clientSecret", clientSecret);
    return { kind: "iframe", url: u.toString() };
  }

  private mapCreated(req: CreateIntentRequest, body: unknown): ProviderResult<CreatedIntent> {
    const bad: ProviderResult<never> = { kind: "invalid_response" };
    const done = (providerRef: string, clientAction: ClientAction, expiresAtMs: number | null): ProviderResult<CreatedIntent> => {
      const a = ClientActionSchema.safeParse(clientAction);
      return a.success ? { kind: "ok", value: { providerRef, clientAction: a.data, expiresAtMs } } : bad;
    };
    switch (req.method) {
      case "card":
      case "meeza": {
        const b = IntentionBase.safeParse(body);
        return b.success ? done(b.data.id, this.hostedAction(b.data.client_secret), null) : bad;
      }
      case "apple_pay": {
        const b = WithApplePay.safeParse(body);
        return b.success ? done(b.data.id, { kind: "apple_pay_session", session_url: b.data.apple_pay_session_url }, null) : bad;
      }
      case "mobile_wallet": {
        const b = WithRedirect.safeParse(body);
        return b.success ? done(b.data.id, { kind: "redirect", url: b.data.redirection_url }, null) : bad;
      }
      case "instapay": {
        const b = WithQr.safeParse(body);
        return b.success ? done(b.data.id, { kind: "qr_payload", payload: b.data.qr_payload }, null) : bad;
      }
      case "fawry": {
        const b = WithFawry.safeParse(body);
        return b.success
          ? done(b.data.id, { kind: "reference_code", reference: b.data.bill_reference, expires_at_ms: b.data.reference_expires_at_ms }, b.data.reference_expires_at_ms)
          : bad;
      }
    }
  }

  private actionResult(body: unknown): ProviderResult<{ id: string; pending: boolean }> {
    const r = ActionResult.safeParse(body);
    if (!r.success) return { kind: "invalid_response" };
    if (!r.data.success && r.data.pending !== true) return { kind: "declined", code: "rejected" };
    return { kind: "ok", value: { id: r.data.id, pending: r.data.pending === true } };
  }

  capture(req: { providerRef: string; amount: bigint; idempotencyKey: string }): Promise<ProviderResult<{ status: "succeeded" }>> {
    return this.simple(
      {
        op: "capture",
        method: "POST",
        path: `/v1/intention/${encodeURIComponent(req.providerRef)}/capture`,
        idempotencyKey: req.idempotencyKey,
        meta: {},
        body: { amount: Number(req.amount) },
      },
      (b) => {
        const r = this.actionResult(b);
        return r.kind !== "ok" ? r : r.value.pending ? { kind: "invalid_response" } : { kind: "ok", value: { status: "succeeded" as const } };
      },
    );
  }

  void(req: { providerRef: string; idempotencyKey: string }): Promise<ProviderResult<{ status: "voided" }>> {
    return this.simple(
      {
        op: "void",
        method: "POST",
        path: `/v1/intention/${encodeURIComponent(req.providerRef)}/void`,
        idempotencyKey: req.idempotencyKey,
        meta: {},
        body: null,
      },
      (b) => {
        const r = this.actionResult(b);
        return r.kind !== "ok" ? r : { kind: "ok", value: { status: "voided" as const } };
      },
    );
  }

  refund(req: { providerRef: string; amount: bigint; idempotencyKey: string; reason: string }): Promise<ProviderResult<RefundOutcome>> {
    if (req.amount <= 0n || req.amount > BigInt(Number.MAX_SAFE_INTEGER)) {
      return Promise.resolve({ kind: "invalid_request", code: "amount_out_of_range" });
    }
    return this.simple(
      {
        op: "refund",
        method: "POST",
        path: `/v1/intention/${encodeURIComponent(req.providerRef)}/refund`,
        idempotencyKey: req.idempotencyKey,
        meta: {},
        body: { amount: Number(req.amount), reason: req.reason.slice(0, 200) },
      },
      (b) => {
        const r = this.actionResult(b);
        if (r.kind !== "ok") return r;
        return { kind: "ok", value: { providerRefundRef: r.value.id, status: r.value.pending ? "pending" : "succeeded" } };
      },
    );
  }

  async retrieve(req: { providerRef: string | null; orderGroupId: string }): Promise<ProviderResult<RetrievedIntent | null>> {
    const path =
      req.providerRef !== null
        ? `/v1/intention/${encodeURIComponent(req.providerRef)}`
        : `/v1/intention/by-reference/${encodeURIComponent(req.orderGroupId)}`;
    const out = await this.call({ op: "retrieve", method: "GET", path, idempotencyKey: null, meta: {}, body: null });
    if (out.kind === "timeout") return { kind: "timeout" };
    if (out.kind === "connect_error") return { kind: "unavailable", code: "connect_error" };
    if (out.status === 404) return { kind: "ok", value: null };
    if (out.status < 200 || out.status >= 300) return this.failureOf(out.status, out.body);
    const r = Retrieved.safeParse(out.body);
    if (!r.success) return { kind: "invalid_response" };
    return {
      kind: "ok",
      value: { providerRef: r.data.id, status: r.data.status, amount: BigInt(r.data.amount_cents), currency: r.data.currency, failureCode: r.data.failure_code },
    };
  }

  deleteToken(req: { pspToken: string }): Promise<ProviderResult<{ status: "deleted" }>> {
    return this.simple(
      { op: "delete_token", method: "DELETE", path: `/v1/tokens/${encodeURIComponent(req.pspToken)}`, idempotencyKey: null, meta: {}, body: null },
      (b) => (z.object({ deleted: z.literal(true) }).safeParse(b).success ? { kind: "ok", value: { status: "deleted" as const } } : { kind: "invalid_response" }),
    );
  }

  // ---- webhooks -----------------------------------------------------------------------------
  private hmacConfig(): HmacWebhookConfig {
    return {
      secrets: this.cfg.webhookSecrets,
      signatureHeader: PAYMOB_SIGNATURE_HEADER,
      timestampHeader: PAYMOB_TIMESTAMP_HEADER,
      algorithm: "sha512",
    };
  }

  verifyWebhook(input: WebhookInput): WebhookVerification {
    return verifyHmacWebhook(this.hmacConfig(), input, (raw) => {
      try {
        const j = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown;
        const t = TxnCallback.safeParse(j);
        if (t.success) {
          const o = t.data.obj;
          // One transaction id fires several callbacks; the state flags are part of the dedup key (VR-PAY-08).
          return `txn:${o.id}:${o.success ? 1 : 0}${o.pending ? 1 : 0}${o.is_voided ? 1 : 0}${o.is_refunded ? 1 : 0}${o.is_auth ? 1 : 0}${o.is_capture ? 1 : 0}`;
        }
        const k = TokenCallback.safeParse(j);
        return k.success ? `token:${k.data.obj.token.slice(-16)}` : null;
      } catch {
        return null;
      }
    });
  }

  parseWebhook(body: JsonValue): ParsedWebhook {
    const t = TxnCallback.safeParse(body);
    if (t.success) {
      const o = t.data.obj;
      const base = {
        providerRef: null,
        orderGroupId: o.order.merchant_order_id,
        amount: BigInt(o.amount_cents),
        currency: o.currency,
        occurredAtMs: o.created_at_ms,
        eventId: `txn:${o.id}`,
      };
      if (o.pending) return { type: "ignored", reason: "pending" };
      if (o.is_refunded) {
        return {
          type: "payment",
          event: {
            ...base,
            kind: o.success ? "refund.succeeded" : "refund.failed",
            failureCode: o.success ? null : (o.data?.message ?? "refund_failed").slice(0, 64),
            providerRefundRef: o.id,
          },
        };
      }
      if (o.is_voided) return { type: "payment", event: { ...base, kind: "payment.voided", failureCode: null, providerRefundRef: null } };
      if (o.success) {
        return {
          type: "payment",
          event: { ...base, kind: o.is_auth && !o.is_capture ? "payment.authorized" : "payment.succeeded", failureCode: null, providerRefundRef: null },
        };
      }
      return {
        type: "payment",
        event: { ...base, kind: "payment.failed", failureCode: (o.data?.message ?? "declined").slice(0, 64), providerRefundRef: null },
      };
    }
    const k = TokenCallback.safeParse(body);
    if (k.success) {
      const o = k.data.obj;
      const last4 = /(\d{4})$/.exec(o.masked_pan)?.[1];
      if (last4 === undefined || o.exp_month === undefined || o.exp_year === undefined || o.fingerprint === undefined || o.merchant_user_id === undefined) {
        return { type: "ignored", reason: "token_callback_incomplete" };
      }
      return {
        type: "card_token",
        eventId: `token:${o.token.slice(-16)}`,
        userId: o.merchant_user_id,
        card: { psp_token: o.token, brand: brandOf(o.card_subtype), last4, exp_month: o.exp_month, exp_year: o.exp_year, fingerprint: o.fingerprint },
      };
    }
    return { type: "invalid", reason: "schema" };
  }
}
