import type { Clock } from "../../../platform/ports";
import type { PaymentIntentRecord, RawEventRecord, RefundRecord, SavedCardRecord } from "../domain/ports";
import { sha256Hex } from "../application/payments";

export const T0 = 1_800_000_000_000;

export class TestClock implements Clock {
  constructor(private ms = T0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SHOPPER_A = U(1);
export const SHOPPER_B = U(2);
export const GROUP_1 = U(100);
export const GROUP_2 = U(101);

let seq = 1000;
export const nextId = (): string => U(seq++);

export function intentRecord(over: Partial<PaymentIntentRecord> = {}): PaymentIntentRecord {
  const id = over.id ?? nextId();
  return {
    id,
    orderGroupId: over.orderGroupId ?? nextId(),
    userId: SHOPPER_A,
    provider: "fake_psp",
    providerRef: null,
    method: "card",
    amount: 125_000n,
    currency: "EGP",
    status: "CREATED",
    refundedAmount: 0n,
    clientAction: null,
    idempotencyKey: over.orderGroupId ?? id,
    failureCode: null,
    expiresAtMs: T0 + 600_000,
    version: 0,
    createdAtMs: T0,
    updatedAtMs: T0,
    ...over,
  };
}

export function rawRecord(over: Partial<RawEventRecord> = {}): RawEventRecord {
  const body = over.body ?? { event_id: "evt_1", type: "payment.succeeded" };
  const sha = over.bodySha256 ?? sha256Hex(JSON.stringify(body));
  const ok = over.signatureOk ?? true;
  return {
    id: nextId(),
    provider: "fake_psp",
    eventId: ok ? "evt_1" : `unverified:${sha}`,
    signatureOk: ok,
    rejectReason: ok ? null : "bad_signature",
    body,
    bodySha256: sha,
    receivedAtMs: T0,
    processedAtMs: null,
    processOutcome: null,
    ...over,
  };
}

export function refundRecord(intentId: string, over: Partial<RefundRecord> = {}): RefundRecord {
  return {
    id: nextId(),
    intentId,
    idempotencyKey: `rf-${seq}`,
    amount: 25_000n,
    status: "pending",
    providerRefundRef: null,
    failureCode: null,
    reason: "return",
    createdAtMs: T0,
    ...over,
  };
}

export function cardRecord(over: Partial<SavedCardRecord> = {}): SavedCardRecord {
  return {
    id: nextId(),
    userId: SHOPPER_A,
    provider: "fake_psp",
    pspToken: `tok_${seq}_aaaaaaaa`,
    brand: "visa",
    last4: "4242",
    expMonth: 12,
    expYear: 2030,
    fingerprint: "fp_aaaaaaaaaaaa",
    createdAtMs: T0,
    ...over,
  };
}
