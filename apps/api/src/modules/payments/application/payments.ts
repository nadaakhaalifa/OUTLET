import { createHash } from "node:crypto";
import type { Clock } from "../../../platform/ports";
import { sanitizeJson, type JsonValue } from "../domain/card-data-guard";
import {
  RAW_EVENT_MAX_BYTES,
  toIntentView,
  type IdPort,
  type PayerContact,
  type PaymentIntentRecord,
  type PaymentMethodSwitchPort,
  type PaymentStore,
  type RawEventRecord,
  type RefundRecord,
  type WebhookIpAllowListPort,
} from "../domain/ports";
import {
  PAYMENT_CURRENCY,
  PAYMENT_METHOD_META,
  decideRefundApplication,
  decideWebhookEffect,
  isPaymentMethodId,
  type MethodUnavailableReason,
  type PaymentMethodId,
  type ProviderId,
} from "../domain/seam";
import type { PspRouter } from "./psp-router";

export const PAYMENT_WEBHOOK_CONSUMER = "payments.webhook_received";
/** A webhook can outrun our own write of the intent; give the relay this long before it is an anomaly. */
const UNKNOWN_INTENT_GRACE_MS = 10 * 60_000;

export class PaymentIntentNotFoundYet extends Error {
  constructor(readonly rawEventId: string) {
    super("payment intent not found yet; retry");
    this.name = "PaymentIntentNotFoundYet";
  }
}

export const sha256Hex = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

export interface Availability {
  readonly method: PaymentMethodId;
  readonly available: boolean;
  readonly reason: MethodUnavailableReason | null;
  readonly paymentWindowMs: number;
  readonly referenceExpiresInMs: number | null;
  readonly stockPool: "standard" | "non_drop";
}

async function availabilityOf(
  method: PaymentMethodId,
  ctx: { containsDropSku: boolean },
  sw: PaymentMethodSwitchPort,
  router: PspRouter,
): Promise<Availability> {
  const meta = PAYMENT_METHOD_META[method];
  let reason: MethodUnavailableReason | null = null;
  if (!(await sw.isEnabled(method))) reason = "kill_switch";
  else if (ctx.containsDropSku && !meta.dropSkusAllowed) reason = "drop_sku_not_allowed";
  else if (!router.isAvailable(method)) reason = "no_provider";
  return {
    method,
    available: reason === null,
    reason,
    paymentWindowMs: meta.paymentWindowMs,
    referenceExpiresInMs: meta.referenceExpiresInMs,
    stockPool: meta.stockPool,
  };
}

export class ListPaymentMethods {
  constructor(
    private readonly sw: PaymentMethodSwitchPort,
    private readonly router: PspRouter,
  ) {}
  async execute(ctx: { containsDropSku: boolean }): Promise<readonly Availability[]> {
    const ids = (Object.keys(PAYMENT_METHOD_META) as PaymentMethodId[]).filter((m) => isPaymentMethodId(m));
    return Promise.all(ids.map((m) => availabilityOf(m, ctx, this.sw, this.router)));
  }
}

// ---- create ---------------------------------------------------------------------------------

export interface CreatePaymentIntentCommand {
  readonly orderGroupId: string;
  readonly userId: string;
  readonly method: PaymentMethodId;
  readonly amount: bigint;
  readonly currency: string;
  readonly containsDropSku: boolean;
  readonly payer: PayerContact;
}

export type CreatePaymentIntentResult =
  | { readonly kind: "created" | "existing"; readonly intent: PaymentIntentRecord }
  | { readonly kind: "pending_unknown"; readonly intent: PaymentIntentRecord }
  | { readonly kind: "method_unavailable"; readonly reason: MethodUnavailableReason }
  | { readonly kind: "invalid"; readonly code: "amount_not_positive" | "currency_not_supported" }
  | { readonly kind: "conflict" }
  | { readonly kind: "declined"; readonly code: string; readonly intent: PaymentIntentRecord }
  | { readonly kind: "provider_unavailable"; readonly intent: PaymentIntentRecord };

export class CreatePaymentIntent {
  constructor(
    private readonly store: PaymentStore,
    private readonly router: PspRouter,
    private readonly sw: PaymentMethodSwitchPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  async execute(cmd: CreatePaymentIntentCommand): Promise<CreatePaymentIntentResult> {
    if (cmd.amount <= 0n) return { kind: "invalid", code: "amount_not_positive" };
    if (cmd.currency !== PAYMENT_CURRENCY) return { kind: "invalid", code: "currency_not_supported" };
    const av = await availabilityOf(cmd.method, { containsDropSku: cmd.containsDropSku }, this.sw, this.router);
    if (!av.available && av.reason !== null) {
      // A replay of an existing intent must still return it even if a breaker is open right now.
      const prior = await this.store.getIntentByOrderGroup(cmd.orderGroupId);
      if (prior === null || av.reason !== "no_provider") return { kind: "method_unavailable", reason: av.reason };
    }
    const now = this.clock.nowMs();
    const meta = PAYMENT_METHOD_META[cmd.method];
    const candidate: PaymentIntentRecord = {
      id: this.ids.uuidV7(),
      orderGroupId: cmd.orderGroupId,
      userId: cmd.userId,
      provider: this.router.order(cmd.method)[0] ?? "unrouted",
      providerRef: null,
      method: cmd.method,
      amount: cmd.amount,
      currency: cmd.currency,
      status: "CREATED",
      refundedAmount: 0n,
      clientAction: null,
      idempotencyKey: cmd.orderGroupId,
      failureCode: null,
      expiresAtMs: now + meta.paymentWindowMs,
      version: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    const ins = await this.store.insertIntent(candidate, []);
    const intent = ins.intent;
    if (ins.kind === "exists") {
      if (intent.userId !== cmd.userId || intent.amount !== cmd.amount || intent.currency !== cmd.currency || intent.method !== cmd.method) {
        return { kind: "conflict" };
      }
      // Resume only a row that never reached a PSP; otherwise it is a plain idempotent replay.
      if (intent.providerRef !== null || intent.status !== "CREATED") return { kind: "existing", intent };
    }
    return this.callProvider(intent, cmd, ins.kind === "inserted" ? "created" : "existing");
  }

  private async callProvider(
    intent: PaymentIntentRecord,
    cmd: CreatePaymentIntentCommand,
    okKind: "created" | "existing",
  ): Promise<CreatePaymentIntentResult> {
    const meta = PAYMENT_METHOD_META[intent.method];
    const routed = await this.router.create(
      {
        orderGroupId: intent.orderGroupId,
        idempotencyKey: intent.idempotencyKey,
        method: intent.method,
        amount: intent.amount,
        currency: intent.currency,
        payer: cmd.payer,
        expiresInMs: meta.paymentWindowMs,
      },
      async (provider: ProviderId) => {
        // Persist which PSP may now hold the intent BEFORE calling it (ambiguity after a timeout).
        await this.store.mutateIntent({
          intentId: intent.id,
          decide: (cur) => (cur.provider === provider ? null : { patch: { provider }, events: [], outcome: "provider_selected" }),
        });
      },
    );
    const r = routed.result;
    if (r.kind === "ok") {
      const expiry = r.value.expiresAtMs;
      const m = await this.store.mutateIntent({
        intentId: intent.id,
        decide: (cur) => ({
          patch: {
            providerRef: r.value.providerRef,
            clientAction: r.value.clientAction,
            ...(cur.status === "CREATED" ? { status: "REQUIRES_ACTION" as const } : {}),
            ...(expiry !== null ? { expiresAtMs: Math.min(expiry, cur.expiresAtMs) } : {}),
          },
          events: [],
          outcome: "provider_created",
        }),
      });
      return m.kind === "applied" ? { kind: okKind, intent: m.intent } : { kind: okKind, intent };
    }
    if (r.kind === "timeout" || r.kind === "invalid_response") {
      const cur = (await this.store.getIntent(intent.id)) ?? intent;
      return { kind: "pending_unknown", intent: cur };
    }
    const code = r.kind === "declined" || r.kind === "invalid_request" || r.kind === "unavailable" ? r.code : "unknown";
    const failedBy = r.kind === "unavailable" ? "provider_unavailable" : code;
    const m = await this.store.mutateIntent({
      intentId: intent.id,
      decide: (cur) =>
        cur.status === "CREATED"
          ? {
              patch: { status: "FAILED", failureCode: failedBy },
              events: [{ type: "payment.failed", intentId: cur.id, orderGroupId: cur.orderGroupId, reason: failedBy }],
              outcome: "create_failed",
            }
          : null,
    });
    const final = m.kind === "applied" ? m.intent : ((await this.store.getIntent(intent.id)) ?? intent);
    return r.kind === "unavailable" ? { kind: "provider_unavailable", intent: final } : { kind: "declined", code, intent: final };
  }
}

// ---- capture / void -----------------------------------------------------------------------------

export type SimpleResult =
  | { readonly kind: "ok"; readonly intent: PaymentIntentRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_state"; readonly status: string }
  | { readonly kind: "provider_failed"; readonly failure: string };

export class CapturePayment {
  constructor(
    private readonly store: PaymentStore,
    private readonly router: PspRouter,
  ) {}
  async execute(intentId: string): Promise<SimpleResult> {
    const i = await this.store.getIntent(intentId);
    if (i === null) return { kind: "not_found" };
    if (i.status === "SUCCEEDED") return { kind: "ok", intent: i };
    if (i.status !== "AUTHORIZED" || i.providerRef === null) return { kind: "invalid_state", status: i.status };
    const ref = i.providerRef;
    const r = await this.router.pinned(i.provider, (p) =>
      p.capture({ providerRef: ref, amount: i.amount, idempotencyKey: `capture:${i.id}` }),
    );
    if (r.kind !== "ok") return { kind: "provider_failed", failure: r.kind };
    const m = await this.store.mutateIntent({
      intentId,
      decide: (cur) =>
        cur.status === "AUTHORIZED"
          ? {
              patch: { status: "SUCCEEDED" },
              events: [
                {
                  type: "payment.succeeded",
                  intentId: cur.id,
                  orderGroupId: cur.orderGroupId,
                  amount: cur.amount,
                  currency: cur.currency,
                  provider: cur.provider,
                  method: cur.method,
                  providerRef: cur.providerRef,
                },
              ],
              outcome: "captured",
            }
          : null,
    });
    return m.kind === "applied" ? { kind: "ok", intent: m.intent } : { kind: "not_found" };
  }
}

export class VoidPayment {
  constructor(
    private readonly store: PaymentStore,
    private readonly router: PspRouter,
  ) {}
  async execute(intentId: string): Promise<SimpleResult> {
    const i = await this.store.getIntent(intentId);
    if (i === null) return { kind: "not_found" };
    if (i.status === "VOIDED") return { kind: "ok", intent: i };
    if (i.status !== "CREATED" && i.status !== "REQUIRES_ACTION" && i.status !== "AUTHORIZED") {
      return { kind: "invalid_state", status: i.status };
    }
    if (i.providerRef !== null) {
      const ref = i.providerRef;
      const r = await this.router.pinned(i.provider, (p) => p.void({ providerRef: ref, idempotencyKey: `void:${i.id}` }));
      if (r.kind !== "ok") return { kind: "provider_failed", failure: r.kind };
    }
    const m = await this.store.mutateIntent({
      intentId,
      decide: (cur) =>
        cur.status === "CREATED" || cur.status === "REQUIRES_ACTION" || cur.status === "AUTHORIZED"
          ? {
              patch: { status: "VOIDED" },
              events: [{ type: "payment.voided", intentId: cur.id, orderGroupId: cur.orderGroupId }],
              outcome: "voided",
            }
          : null,
    });
    return m.kind === "applied" ? { kind: "ok", intent: m.intent } : { kind: "not_found" };
  }
}

// ---- refund ---------------------------------------------------------------------------------

export interface RefundCommand {
  readonly intentId: string;
  readonly amount: bigint;
  /** Caller supplied (the refund router derives it from the refund id). Same key = same refund. */
  readonly idempotencyKey: string;
  readonly reason: string;
}

export type RefundResult =
  | { readonly kind: "completed" | "pending" | "failed"; readonly refund: RefundRecord }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_refundable" }
  | { readonly kind: "exceeds_captured" }
  | { readonly kind: "invalid_amount" };

export class RefundPayment {
  constructor(
    private readonly store: PaymentStore,
    private readonly router: PspRouter,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  async execute(cmd: RefundCommand): Promise<RefundResult> {
    if (cmd.amount <= 0n) return { kind: "invalid_amount" };
    const intent = await this.store.getIntent(cmd.intentId);
    if (intent === null) return { kind: "not_found" };
    const rec: RefundRecord = {
      id: this.ids.uuidV7(),
      intentId: intent.id,
      idempotencyKey: cmd.idempotencyKey,
      amount: cmd.amount,
      status: "pending",
      providerRefundRef: null,
      failureCode: null,
      reason: cmd.reason,
      createdAtMs: this.clock.nowMs(),
    };
    const ins = await this.store.insertRefund(rec);
    if (ins.kind === "exceeds_captured") return { kind: "exceeds_captured" };
    if (ins.kind === "not_refundable") return { kind: "not_refundable" };
    const refund = ins.refund;
    if (ins.kind === "exists") {
      if (refund.amount !== cmd.amount) return { kind: "invalid_amount" };
      if (refund.status === "succeeded") return { kind: "completed", refund };
      if (refund.status === "failed") return { kind: "failed", refund };
    }
    if (intent.providerRef === null) return { kind: "not_refundable" };
    const ref = intent.providerRef;
    const r = await this.router.pinned(intent.provider, (p) =>
      p.refund({ providerRef: ref, amount: refund.amount, idempotencyKey: refund.idempotencyKey, reason: cmd.reason }),
    );
    if (r.kind === "ok") {
      if (r.value.status === "pending") return { kind: "pending", refund };
      const s = await this.store.settleRefund({
        refundId: refund.id,
        outcome: "succeeded",
        providerRefundRef: r.value.providerRefundRef,
        failureCode: null,
      });
      return s.kind === "applied" || s.kind === "already_settled" ? { kind: "completed", refund: s.refund } : { kind: "pending", refund };
    }
    if (r.kind === "declined" || r.kind === "invalid_request") {
      const s = await this.store.settleRefund({ refundId: refund.id, outcome: "failed", providerRefundRef: null, failureCode: r.code });
      return s.kind === "applied" || s.kind === "already_settled" ? { kind: "failed", refund: s.refund } : { kind: "failed", refund };
    }
    // timeout / unavailable / invalid_response: the refund stays pending and the same key is safe to retry.
    return { kind: "pending", refund };
  }
}

/**
 * F-9 resolution path. A refund whose provider call timed out has no provider reference, and a
 * webhook for it may be unattributable. The PSP's refund endpoint is idempotent on the key, so
 * replaying the stored key returns that refund's own outcome. Never settles by amount.
 */
export class ResolvePendingRefunds {
  constructor(
    private readonly store: PaymentStore,
    private readonly router: PspRouter,
  ) {}

  async execute(limit = 100): Promise<number> {
    let n = 0;
    for (const refund of await this.store.listPendingRefundsWithoutRef(limit)) {
      const intent = await this.store.getIntent(refund.intentId);
      if (intent === null || intent.providerRef === null) continue;
      const ref = intent.providerRef;
      const r = await this.router.pinned(intent.provider, (p) =>
        p.refund({ providerRef: ref, amount: refund.amount, idempotencyKey: refund.idempotencyKey, reason: refund.reason }),
      );
      if (r.kind === "ok" && r.value.status === "succeeded") {
        await this.store.settleRefund({ refundId: refund.id, outcome: "succeeded", providerRefundRef: r.value.providerRefundRef, failureCode: null });
        n += 1;
      } else if (r.kind === "declined" || r.kind === "invalid_request") {
        await this.store.settleRefund({ refundId: refund.id, outcome: "failed", providerRefundRef: null, failureCode: r.code });
        n += 1;
      }
    }
    return n;
  }
}

// ---- webhook intake -------------------------------------------------------------------------------

export type ReceiveWebhookResult =
  | { readonly kind: "unknown_provider" }
  | { readonly kind: "ip_denied" }
  | { readonly kind: "too_large" }
  | { readonly kind: "accepted"; readonly signatureOk: boolean; readonly duplicate: boolean };

export interface ReceiveWebhookInput {
  readonly provider: string;
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly ip: string | undefined;
}

export class ReceiveWebhook {
  constructor(
    private readonly store: PaymentStore,
    private readonly router: PspRouter,
    private readonly ipAllow: WebhookIpAllowListPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  async execute(input: ReceiveWebhookInput): Promise<ReceiveWebhookResult> {
    const port = this.router.provider(input.provider);
    if (port === null) return { kind: "unknown_provider" };
    if (input.rawBody.byteLength > RAW_EVENT_MAX_BYTES) return { kind: "too_large" };
    if (!(await this.ipAllow.isAllowed(port.id, input.ip))) return { kind: "ip_denied" };
    const now = this.clock.nowMs();
    const bodySha256 = sha256Hex(input.rawBody);
    const v = port.verifyWebhook({ rawBody: input.rawBody, headers: input.headers, nowMs: now });
    const body = this.sanitizedBody(input.rawBody, bodySha256);
    const redacted = body.redacted;
    const rec: RawEventRecord = {
      id: this.ids.uuidV7(),
      provider: port.id,
      // Unverified rows get a content-derived id so a forged event id can never block a genuine one.
      eventId: v.ok ? v.eventId : `unverified:${bodySha256}`,
      signatureOk: v.ok,
      rejectReason: v.ok ? null : v.reason,
      body: redacted ? { ...asObject(body.value), _redacted: true } : body.value,
      bodySha256,
      receivedAtMs: now,
      processedAtMs: null,
      processOutcome: null,
    };
    const stored = await this.store.recordRawEvent(
      rec,
      redacted
        ? [{ type: "payment.anomaly", intentId: null, orderGroupId: null, anomaly: "pan_in_webhook", detail: port.id }]
        : [],
    );
    return { kind: "accepted", signatureOk: v.ok, duplicate: stored === "duplicate" };
  }

  private sanitizedBody(raw: Uint8Array, sha: string): { value: JsonValue; redacted: boolean } {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
      const parsed = JSON.parse(text) as JsonValue;
      const s = sanitizeJson(parsed);
      return { value: s.value, redacted: s.redacted };
    } catch {
      // Non JSON or not UTF-8: keep only a digest, never the text.
      return { value: { _unparsed_sha256: sha }, redacted: false };
    }
  }
}

const asObject = (v: JsonValue): { [k: string]: JsonValue } =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? v : { _value: v };

// ---- webhook processing (outbox consumer) ----------------------------------------------------

export type ProcessOutcome =
  | "missing"
  | "ignored_unverified"
  | "duplicate"
  | "transition"
  | "noop"
  | "anomaly"
  | "refund_settled"
  | "card_saved"
  | "ignored";

export class ProcessPaymentWebhook {
  constructor(
    private readonly store: PaymentStore,
    private readonly router: PspRouter,
    private readonly clock: Clock,
    private readonly ids: IdPort,
  ) {}

  /** `messageId` is the outbox event id (inbox key); defaults to the raw event id for polling drains. */
  async handle(rawEventId: string, messageId: string = rawEventId): Promise<ProcessOutcome> {
    const raw = await this.store.getRawEvent(rawEventId);
    if (raw === null) return "missing";
    if (!raw.signatureOk) return "ignored_unverified";
    if (raw.processedAtMs !== null) return "duplicate";
    const inbox = { consumer: PAYMENT_WEBHOOK_CONSUMER, messageId };
    const port = this.router.provider(raw.provider);
    if (port === null) {
      await this.store.settleRawEvent({ rawEventId, outcome: "unknown_provider", events: [], inbox });
      return "ignored";
    }
    const parsed = port.parseWebhook(raw.body);
    if (parsed.type === "ignored" || parsed.type === "invalid") {
      await this.store.settleRawEvent({ rawEventId, outcome: `${parsed.type}:${parsed.reason}`.slice(0, 120), events: [], inbox });
      return "ignored";
    }
    if (parsed.type === "card_token") {
      await this.store.upsertSavedCard(
        {
          id: this.ids.uuidV7(),
          userId: parsed.userId,
          provider: raw.provider,
          pspToken: parsed.card.psp_token,
          brand: parsed.card.brand,
          last4: parsed.card.last4,
          expMonth: parsed.card.exp_month,
          expYear: parsed.card.exp_year,
          fingerprint: parsed.card.fingerprint,
          createdAtMs: this.clock.nowMs(),
        },
        rawEventId,
      );
      return "card_saved";
    }
    const ev = parsed.event;
    const byRef = ev.providerRef === null ? null : await this.store.getIntentByProviderRef(raw.provider, ev.providerRef);
    const byGroup = byRef ?? (ev.orderGroupId === null ? null : await this.store.getIntentByOrderGroup(ev.orderGroupId));
    if (byGroup === null) {
      if (this.clock.nowMs() - raw.receivedAtMs < UNKNOWN_INTENT_GRACE_MS) throw new PaymentIntentNotFoundYet(rawEventId);
      await this.store.settleRawEvent({
        rawEventId,
        outcome: "unknown_intent",
        events: [{ type: "payment.anomaly", intentId: null, orderGroupId: ev.orderGroupId, anomaly: "unknown_intent", detail: "no matching intent" }],
        inbox,
      });
      return "anomaly";
    }
    const intent = byGroup;
    if (intent.provider !== raw.provider) {
      await this.store.settleRawEvent({
        rawEventId,
        outcome: "provider_mismatch",
        events: [
          { type: "payment.anomaly", intentId: intent.id, orderGroupId: intent.orderGroupId, anomaly: "unknown_intent", detail: "provider_mismatch" },
        ],
        inbox,
      });
      return "anomaly";
    }

    if (ev.kind === "refund.succeeded" || ev.kind === "refund.failed") {
      let refund = ev.providerRefundRef === null ? null : await this.store.getRefundByProviderRef(ev.providerRefundRef);
      let detail: string = ev.kind;
      if (refund === null) {
        // F-9: settle by amount only when exactly one pending refund matches. With two or more the
        // event cannot be attributed (equal amounts, out-of-order webhooks): park it as an anomaly
        // and let ResolvePendingRefunds settle each by replaying its own idempotency key.
        const candidates = await this.store.findPendingRefunds(intent.id, ev.amount);
        if (candidates.length === 1) refund = candidates[0] ?? null;
        else if (candidates.length > 1) detail = `${ev.kind}:ambiguous_pending_refund`;
      }
      if (refund === null || refund.intentId !== intent.id) {
        await this.store.settleRawEvent({
          rawEventId,
          outcome: "unknown_refund",
          events: [{ type: "payment.anomaly", intentId: intent.id, orderGroupId: intent.orderGroupId, anomaly: "unknown_refund", detail }],
          inbox,
        });
        return "anomaly";
      }
      const r = await this.store.settleRefund({
        refundId: refund.id,
        outcome: ev.kind === "refund.succeeded" ? "succeeded" : "failed",
        providerRefundRef: ev.providerRefundRef,
        failureCode: ev.failureCode,
        inbox,
        rawEventId,
      });
      return r.kind === "duplicate" ? "duplicate" : "refund_settled";
    }

    let outcome: ProcessOutcome = "noop";
    const m = await this.store.mutateIntent({
      intentId: intent.id,
      inbox,
      rawEventId,
      decide: (cur) => {
        const d = decideWebhookEffect(toIntentView(cur), ev);
        if (d.kind === "transition") {
          outcome = "transition";
          return {
            patch: { status: d.to, ...(d.failureCode !== null ? { failureCode: d.failureCode } : {}) },
            events: d.events,
            outcome: `transition:${d.to}`,
          };
        }
        if (d.kind === "anomaly") {
          outcome = "anomaly";
          return { patch: {}, events: d.events, outcome: `anomaly:${d.anomaly}` };
        }
        outcome = "noop";
        return null;
      },
    });
    return m.kind === "duplicate" ? "duplicate" : outcome;
  }

  /** Polling drain for recovery and tests: processes stored events the relay has not delivered. */
  async drain(limit: number): Promise<number> {
    const ids = await this.store.listUnprocessedEventIds(limit);
    let n = 0;
    for (const id of ids) {
      try {
        await this.handle(id);
        n += 1;
      } catch (e) {
        if (!(e instanceof PaymentIntentNotFoundYet)) throw e;
      }
    }
    return n;
  }
}

// ---- expiry sweeper -----------------------------------------------------------------------------

export class ExpirePaymentIntents {
  constructor(
    private readonly store: PaymentStore,
    private readonly router: PspRouter,
    private readonly clock: Clock,
  ) {}

  /** Retrieves before voiding: a late success wins over an expiry. Returns the number resolved. */
  async execute(limit = 100): Promise<number> {
    const due = await this.store.listExpirable(this.clock.nowMs(), limit);
    let n = 0;
    for (const i of due) {
      const rr = await this.router.pinned(i.provider, (p) => p.retrieve({ providerRef: i.providerRef, orderGroupId: i.orderGroupId }));
      if (rr.kind !== "ok") continue; // unknown: leave it, try again next sweep
      const remote = rr.value;
      if (remote !== null && (remote.status === "SUCCEEDED" || remote.status === "AUTHORIZED")) {
        const ev = {
          eventId: `sweep:${i.id}`,
          kind: remote.status === "SUCCEEDED" ? ("payment.succeeded" as const) : ("payment.authorized" as const),
          providerRef: remote.providerRef,
          orderGroupId: i.orderGroupId,
          amount: remote.amount,
          currency: remote.currency,
          occurredAtMs: this.clock.nowMs(),
          failureCode: null,
          providerRefundRef: null,
        };
        await this.store.mutateIntent({
          intentId: i.id,
          decide: (cur) => {
            const d = decideWebhookEffect(toIntentView(cur), ev);
            if (d.kind === "transition") return { patch: { status: d.to }, events: d.events, outcome: "swept_success" };
            if (d.kind === "anomaly") return { patch: {}, events: d.events, outcome: `anomaly:${d.anomaly}` };
            return null;
          },
        });
        n += 1;
        continue;
      }
      if (i.providerRef !== null) {
        const ref = i.providerRef;
        const v = await this.router.pinned(i.provider, (p) => p.void({ providerRef: ref, idempotencyKey: `void:${i.id}` }));
        if (v.kind !== "ok" && v.kind !== "declined") continue;
      }
      await this.store.mutateIntent({
        intentId: i.id,
        decide: (cur) =>
          cur.status === "CREATED" || cur.status === "REQUIRES_ACTION"
            ? {
                patch: { status: "FAILED", failureCode: "expired" },
                events: [{ type: "payment.failed", intentId: cur.id, orderGroupId: cur.orderGroupId, reason: "expired" }],
                outcome: "expired",
              }
            : null,
      });
      n += 1;
    }
    return n;
  }
}

// ---- saved cards --------------------------------------------------------------------------------

export class ListSavedCards {
  constructor(private readonly store: PaymentStore) {}
  execute(userId: string) {
    return this.store.listSavedCards(userId);
  }
}

export type DeleteSavedCardResult = "deleted" | "not_found" | "provider_unavailable";

export class DeleteSavedCard {
  constructor(
    private readonly store: PaymentStore,
    private readonly router: PspRouter,
    private readonly clock: Clock,
  ) {}
  async execute(userId: string, cardId: string): Promise<DeleteSavedCardResult> {
    const card = await this.store.getSavedCard(cardId, userId); // owner scoped: someone else's id is not_found
    if (card === null) return "not_found";
    const r = await this.router.pinned(card.provider, (p) => p.deleteToken({ pspToken: card.pspToken }));
    if (r.kind !== "ok" && r.kind !== "declined") return "provider_unavailable";
    return (await this.store.deleteSavedCard(cardId, userId, this.clock.nowMs())) ? "deleted" : "not_found";
  }
}

export { decideRefundApplication };
