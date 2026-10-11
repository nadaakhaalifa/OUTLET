import { sha256Hex } from "@outlet/idempotency";
import { initialFacts, reconfirm, type CheckoutMethod } from "../domain/bridge";
import type { ClientAction, SagaRecord } from "../domain/ports";
import type { CheckoutContext } from "./context";
import { QuoteCheckout, type MethodUnavailableReason, type QuoteOk } from "./quote";
import { SagaRunner, type Shortfall } from "./saga-runner";

export interface CommitInput {
  readonly userId: string;
  readonly deviceId: string | null;
  readonly idempotencyKey: string;
  readonly method: CheckoutMethod;
  readonly addressId: string | null;
  readonly codes: readonly string[];
  readonly useStoreCredit: boolean;
  readonly priceLock: string | null;
  /** The total the shopper confirmed. A difference is a 409 with the delta (spec 7). */
  readonly expectedTotal: bigint | null;
  readonly appAttestAssertion: string | null;
}

export type CommitState = "placed" | "pending" | "awaiting_confirmation";

export type CommitResult =
  | {
      readonly kind: "ok";
      readonly record: SagaRecord;
      readonly state: CommitState;
      readonly clientAction: ClientAction;
      readonly replayed: boolean;
    }
  | { readonly kind: "app_attest_required" }
  | { readonly kind: "key_reuse" }
  | { readonly kind: "address_required" }
  | { readonly kind: "address_not_found" }
  | { readonly kind: "address_not_covered" }
  | { readonly kind: "bag_empty" }
  | { readonly kind: "method_unavailable"; readonly reason: MethodUnavailableReason }
  | {
      readonly kind: "price_changed";
      readonly expected: bigint;
      readonly actual: bigint;
      readonly delta: bigint;
      readonly fresh: QuoteOk;
    }
  | { readonly kind: "insufficient_stock"; readonly shortfalls: readonly Shortfall[] }
  | { readonly kind: "payment_unavailable" }
  | { readonly kind: "failed"; readonly reason: string; readonly record: SagaRecord };

const NONE: ClientAction = { type: "none" };

export function requestHashOf(i: CommitInput): string {
  return sha256Hex(
    JSON.stringify([
      i.method,
      i.addressId,
      [...i.codes].map((c) => c.trim().toUpperCase()).sort(),
      i.useStoreCredit,
      i.expectedTotal === null ? null : i.expectedTotal.toString(),
    ]),
  );
}

/** Maps the saga's current state to the HTTP-facing outcome. Shared by commit, replay and status. */
export function outcomeOf(record: SagaRecord, shortfalls: readonly Shortfall[] | null, replayed: boolean): CommitResult {
  const f = record.facts;
  if (f.status === "PLACED") {
    return { kind: "ok", record, state: "placed", clientAction: NONE, replayed };
  }
  if (f.status === "FAILED" || f.status === "EXPIRED" || f.status === "CANCELLED" || f.status === "REFUNDED") {
    const reason = f.compensating?.reason ?? "failed";
    if (reason === "stock_unavailable") return { kind: "insufficient_stock", shortfalls: shortfalls ?? [] };
    if (reason === "intent_rejected") return { kind: "payment_unavailable" };
    return { kind: "failed", reason, record };
  }
  const state: CommitState = f.method === "cod" && f.codConfirmation === "pending" ? "awaiting_confirmation" : "pending";
  const action: ClientAction =
    state === "awaiting_confirmation" ? { type: "await_confirmation", channel: "whatsapp" } : (record.clientAction ?? NONE);
  return { kind: "ok", record, state, clientAction: action, replayed };
}

/** POST /v1/checkout: re-prices, enforces gates, creates the saga row and drives it to its first wait point. */
export class PlaceCheckout {
  private readonly quote: QuoteCheckout;
  private readonly runner: SagaRunner;
  constructor(private readonly ctx: CheckoutContext) {
    this.quote = new QuoteCheckout(ctx);
    this.runner = new SagaRunner(ctx);
  }

  async execute(i: CommitInput): Promise<CommitResult> {
    const { ctx } = this;
    const requestHash = requestHashOf(i);

    // Replay of the same key: never re-run gates (a changed bag must not break an idempotent retry).
    const prior = await ctx.repo.findByKey(i.userId, i.idempotencyKey);
    if (prior !== null) {
      if (prior.requestHash !== requestHash) return { kind: "key_reuse" };
      const d = await this.runner.drive(prior.orderGroupId);
      return outcomeOf(d.record, d.shortfalls, true);
    }

    if (ctx.requireAppAttest) {
      const ok = await ctx.appAttest.verify({
        userId: i.userId,
        deviceId: i.deviceId,
        assertion: i.appAttestAssertion,
      });
      if (!ok) return { kind: "app_attest_required" };
    }
    if (i.addressId === null) return { kind: "address_required" };

    const q = await this.quote.execute({
      userId: i.userId,
      deviceId: i.deviceId,
      method: i.method,
      addressId: i.addressId,
      codes: i.codes,
      useStoreCredit: i.useStoreCredit,
      priceLock: i.priceLock,
    });
    if (q.kind !== "ok") {
      if (q.kind === "method_unavailable") return { kind: "method_unavailable", reason: q.reason };
      return { kind: q.kind };
    }
    if (q.buyer === null) return { kind: "address_required" };

    const rc = reconfirm(i.expectedTotal, q.quote.total.amount);
    if (rc.kind === "changed") {
      return { kind: "price_changed", expected: rc.expected, actual: rc.actual, delta: rc.delta, fresh: q };
    }

    const nowMs = ctx.clock.nowMs();
    const orderGroupId = ctx.ids.uuidV7();
    const record: SagaRecord = {
      orderGroupId,
      userId: i.userId,
      idempotencyKey: i.idempotencyKey,
      requestHash,
      cartHash: q.cartHash,
      facts: initialFacts({
        method: i.method,
        creditAmount: q.quote.tender.storeCreditTotal.amount,
        externalDue: q.quote.tender.externalDue.amount,
        codNeedsConfirmation: q.codNeedsConfirmation,
      }),
      stored: { quote: q.quote, lines: q.lines, commissionBps: q.commissionBps, buyer: q.buyer, addressId: q.addressId, lockExpiresAtMs: q.lockExpiresAtMs },
      provider: null,
      clientAction: null,
      version: 0,
      attempts: 0,
      nextWakeAtMs: nowMs,
      lastError: null,
      stuck: false,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const created = await ctx.repo.create(record, []);
    if (created.kind !== "created") {
      // Same key raced us, or a different key for the same bag and method: one OrderGroup (spec 7).
      const existing = created.existing;
      if (created.kind === "duplicate_key" && existing.requestHash !== requestHash) return { kind: "key_reuse" };
      const d = await this.runner.drive(existing.orderGroupId);
      return outcomeOf(d.record, d.shortfalls, true);
    }
    const d = await this.runner.drive(orderGroupId);
    return outcomeOf(d.record, d.shortfalls, false);
  }
}
