import type { ClientAction } from "../domain/schemas";
import type {
  CreateIntentRequest,
  CreatedIntent,
  JsonValue,
  ParsedWebhook,
  PaymentProviderPort,
  ProviderFailure,
  ProviderResult,
  RefundOutcome,
  RetrievedIntent,
  WebhookInput,
  WebhookVerification,
} from "../domain/ports";
import { PAYMENT_METHOD_IDS, PAYMENT_METHOD_META, type PaymentIntentStatus, type PaymentMethodId } from "../domain/seam";
import { signBody, verifyHmacWebhook, type HmacWebhookConfig } from "./hmac-webhook";
import { eventIdFromBytes, parseFakeBody, type FakeWebhookBody } from "./webhook-body";

export type FakeOp = "create" | "capture" | "void" | "refund" | "retrieve" | "delete_token";

interface FakeIntent {
  providerRef: string;
  orderGroupId: string;
  amount: bigint;
  currency: string;
  method: PaymentMethodId;
  status: PaymentIntentStatus;
  created: CreatedIntent;
}

export const FAKE_SIGNATURE_HEADER = "x-fake-signature";
export const FAKE_TIMESTAMP_HEADER = "x-fake-timestamp";

/**
 * In-repo fake PSP (the only provider that exists in this repo besides the fixture-only Paymob
 * adapter). Deterministic: references derive from the order group, nothing random, no network.
 * Failures are scripted per operation: `failNext("create", {kind: "timeout"})`.
 */
export class FakePaymentProvider implements PaymentProviderPort {
  readonly methods: readonly PaymentMethodId[];
  private readonly intents = new Map<string, FakeIntent>();
  private readonly script = new Map<FakeOp, ProviderFailure[]>();
  private readonly refundsByKey = new Map<string, RefundOutcome>();
  readonly calls: { op: FakeOp; key: string }[] = [];
  readonly deletedTokens: string[] = [];
  private refundSeq = 0;

  constructor(
    readonly id: string = "fake_psp",
    private readonly secret: string = "fake-webhook-secret-not-real",
    methods: readonly PaymentMethodId[] = PAYMENT_METHOD_IDS,
    private readonly nowMs: () => number = () => Date.now(),
  ) {
    this.methods = methods;
  }

  failNext(op: FakeOp, failure: ProviderFailure, times = 1): void {
    const q = this.script.get(op) ?? [];
    for (let i = 0; i < times; i++) q.push(failure);
    this.script.set(op, q);
  }

  /** The PSP-side status of an intent (what `retrieve` reports). Tests move it to simulate the shopper paying. */
  setRemoteStatus(orderGroupId: string, status: PaymentIntentStatus): void {
    const i = this.intents.get(orderGroupId);
    if (i !== undefined) i.status = status;
  }

  remoteIntent(orderGroupId: string): Readonly<FakeIntent> | undefined {
    return this.intents.get(orderGroupId);
  }

  callCount(op: FakeOp): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  private next(op: FakeOp, key: string): ProviderFailure | null {
    this.calls.push({ op, key });
    const q = this.script.get(op);
    return q?.shift() ?? null;
  }

  private actionFor(method: PaymentMethodId, ref: string, expiresInMs: number): { action: ClientAction; expiresAtMs: number | null } {
    const meta = PAYMENT_METHOD_META[method];
    switch (method) {
      case "card":
      case "meeza":
        return { action: { kind: "iframe", url: `https://fake-psp.invalid/pay/${ref}` }, expiresAtMs: null };
      case "apple_pay":
        return { action: { kind: "apple_pay_session", session_url: `https://fake-psp.invalid/apple-pay/${ref}` }, expiresAtMs: null };
      case "mobile_wallet":
        return { action: { kind: "wallet_prompt", message_code: "approve_in_wallet_app" }, expiresAtMs: null };
      case "instapay":
        return { action: { kind: "qr_payload", payload: `fake-instapay:${ref}` }, expiresAtMs: null };
      case "fawry": {
        const expires = this.nowMs() + (meta.referenceExpiresInMs ?? expiresInMs);
        return { action: { kind: "reference_code", reference: `FW${ref.slice(-8).toUpperCase().replace(/[^0-9A-Z]/g, "0")}`, expires_at_ms: expires }, expiresAtMs: expires };
      }
    }
  }

  async createIntent(req: CreateIntentRequest): Promise<ProviderResult<CreatedIntent>> {
    const f = this.next("create", req.orderGroupId);
    if (f !== null) return f;
    if (!this.methods.includes(req.method)) return { kind: "invalid_request", code: "method_not_supported" };
    const existing = this.intents.get(req.orderGroupId);
    if (existing !== undefined) {
      if (existing.amount !== req.amount || existing.method !== req.method) return { kind: "invalid_request", code: "idempotency_mismatch" };
      return { kind: "ok", value: existing.created };
    }
    const providerRef = `fake_pi_${req.orderGroupId.replace(/-/g, "")}`;
    const a = this.actionFor(req.method, providerRef, req.expiresInMs);
    const created: CreatedIntent = { providerRef, clientAction: a.action, expiresAtMs: a.expiresAtMs };
    this.intents.set(req.orderGroupId, {
      providerRef,
      orderGroupId: req.orderGroupId,
      amount: req.amount,
      currency: req.currency,
      method: req.method,
      status: "REQUIRES_ACTION",
      created,
    });
    return { kind: "ok", value: created };
  }

  private byRef(providerRef: string): FakeIntent | undefined {
    for (const i of this.intents.values()) if (i.providerRef === providerRef) return i;
    return undefined;
  }

  async capture(req: { providerRef: string; amount: bigint; idempotencyKey: string }): Promise<ProviderResult<{ status: "succeeded" }>> {
    const f = this.next("capture", req.idempotencyKey);
    if (f !== null) return f;
    const i = this.byRef(req.providerRef);
    if (i === undefined) return { kind: "invalid_request", code: "unknown_reference" };
    if (i.status === "SUCCEEDED") return { kind: "ok", value: { status: "succeeded" } };
    if (i.status !== "AUTHORIZED") return { kind: "declined", code: "not_authorized" };
    if (req.amount !== i.amount) return { kind: "invalid_request", code: "amount_mismatch" };
    i.status = "SUCCEEDED";
    return { kind: "ok", value: { status: "succeeded" } };
  }

  async void(req: { providerRef: string; idempotencyKey: string }): Promise<ProviderResult<{ status: "voided" }>> {
    const f = this.next("void", req.idempotencyKey);
    if (f !== null) return f;
    const i = this.byRef(req.providerRef);
    if (i === undefined) return { kind: "invalid_request", code: "unknown_reference" };
    if (i.status === "VOIDED") return { kind: "ok", value: { status: "voided" } };
    if (i.status === "SUCCEEDED" || i.status === "PARTIALLY_REFUNDED" || i.status === "REFUNDED") {
      return { kind: "declined", code: "already_captured" };
    }
    i.status = "VOIDED";
    return { kind: "ok", value: { status: "voided" } };
  }

  async refund(req: { providerRef: string; amount: bigint; idempotencyKey: string; reason: string }): Promise<ProviderResult<RefundOutcome>> {
    const f = this.next("refund", req.idempotencyKey);
    if (f !== null) return f;
    const prior = this.refundsByKey.get(req.idempotencyKey);
    if (prior !== undefined) return { kind: "ok", value: prior };
    const i = this.byRef(req.providerRef);
    if (i === undefined) return { kind: "invalid_request", code: "unknown_reference" };
    if (i.status !== "SUCCEEDED" && i.status !== "PARTIALLY_REFUNDED") return { kind: "declined", code: "not_refundable" };
    this.refundSeq += 1;
    const out: RefundOutcome = { providerRefundRef: `fake_rf_${this.refundSeq}`, status: "succeeded" };
    this.refundsByKey.set(req.idempotencyKey, out);
    return { kind: "ok", value: out };
  }

  async retrieve(req: { providerRef: string | null; orderGroupId: string }): Promise<ProviderResult<RetrievedIntent | null>> {
    const f = this.next("retrieve", req.orderGroupId);
    if (f !== null) return f;
    const i = this.intents.get(req.orderGroupId) ?? (req.providerRef === null ? undefined : this.byRef(req.providerRef));
    if (i === undefined) return { kind: "ok", value: null };
    return { kind: "ok", value: { providerRef: i.providerRef, status: i.status, amount: i.amount, currency: i.currency, failureCode: null } };
  }

  async deleteToken(req: { pspToken: string }): Promise<ProviderResult<{ status: "deleted" }>> {
    const f = this.next("delete_token", req.pspToken);
    if (f !== null) return f;
    this.deletedTokens.push(req.pspToken);
    return { kind: "ok", value: { status: "deleted" } };
  }

  // ---- webhooks -----------------------------------------------------------------------------
  private hmacConfig(): HmacWebhookConfig {
    return { secrets: [this.secret], signatureHeader: FAKE_SIGNATURE_HEADER, timestampHeader: FAKE_TIMESTAMP_HEADER, algorithm: "sha256" };
  }

  verifyWebhook(input: WebhookInput): WebhookVerification {
    return verifyHmacWebhook(this.hmacConfig(), input, eventIdFromBytes);
  }

  parseWebhook(body: JsonValue): ParsedWebhook {
    return parseFakeBody(body);
  }

  /** Test helper: the exact bytes and headers the fake PSP would POST for `body`. */
  signedWebhook(body: FakeWebhookBody | Record<string, unknown>, timestampMs: number = this.nowMs()): {
    rawBody: Uint8Array;
    headers: Record<string, string>;
  } {
    const rawBody = new TextEncoder().encode(JSON.stringify(body));
    return {
      rawBody,
      headers: {
        [FAKE_SIGNATURE_HEADER]: signBody({ algorithm: "sha256" }, this.secret, timestampMs, rawBody),
        [FAKE_TIMESTAMP_HEADER]: String(timestampMs),
        "content-type": "application/json",
      },
    };
  }
}
