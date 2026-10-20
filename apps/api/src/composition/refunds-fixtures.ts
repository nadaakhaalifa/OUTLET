import type { RefundFacts } from "../modules/refunds";
import { money } from "./domain";

// Local copy of the refunds module fixtures: composition tests may import only the public index.
type OriginalTender = RefundFacts["tenders"][number];
type PaymentMethod = OriginalTender["method"];
interface ClockPort {
  nowMs(): number;
}
interface IdPort {
  uuidV7(): string;
}

export const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);

export const U = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const SHOPPER_A = U(0xa1);
export const SHOPPER_B = U(0xb1);
export const STORE_A = U(0x51);
export const SELLER_ORDER_1 = U(0x501);

export class TestClock implements ClockPort {
  constructor(public ms: number = T0) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export class SeqIds implements IdPort {
  constructor(private n = 0x10000) {}
  uuidV7(): string {
    this.n += 1;
    return U(this.n);
  }
}

export const tender = (id: string, method: PaymentMethod, amount: bigint, extra: Partial<OriginalTender> = {}): OriginalTender => ({
  id,
  method,
  amount: money(amount),
  refundedBefore: money(0n),
  psp: "paymob",
  provider: "valu",
  courier: "bosta",
  ...extra,
});

export const ORDER_GROUP_1 = U(0x601);

export const facts = (tenders: readonly OriginalTender[], over: Partial<RefundFacts> = {}): RefundFacts => ({
  userId: SHOPPER_A,
  storeId: STORE_A,
  orderGroupId: ORDER_GROUP_1,
  deliveryFee: 0n,
  deliveryFeeRefundedBefore: 0n,
  commissionBps: 1000n,
  vatBps: 1400n,
  tenders,
  // One line worth what the tenders paid, unless a test states otherwise.
  lines: [{ orderLineId: "line-1", gross: tenders.reduce((a, t) => a + t.amount.amount, 0n), refundedBefore: 0n }],
  platformVoucher: 0n,
  sellerVoucher: 0n,
  returnReceivedAtMs: T0,
  choice: { cod: "store_credit" },
  ...over,
});

export function intent(
  n: number,
  over: { net?: bigint; preference?: "original_method" | "store_credit"; userId?: string; storeId?: string; sellerOrderId?: string } = {},
): unknown {
  const net = over.net ?? 10_000n;
  return {
    messageId: U(0x7000 + n),
    event: {
      name: "return.refund_intent",
      returnId: U(0x8000 + n),
      userId: over.userId ?? SHOPPER_A,
      storeId: over.storeId ?? STORE_A,
      sellerOrderId: over.sellerOrderId ?? SELLER_ORDER_1,
      orderLineId: "line-1",
      reason: "too_small",
      refundPreference: over.preference ?? "original_method",
      shippingPayer: "seller",
      currency: "EGP",
      allocation: {
        lines: [
          { orderLineId: "line-1", qty: 1, itemAmount: net.toString(), voucherShare: "0", deliveryFeeShare: "0", netAmount: net.toString() },
        ],
        itemTotal: net.toString(),
        voucherTotal: "0",
        deliveryFeeTotal: "0",
        netTotal: net.toString(),
      },
      idempotencyKey: `refund-intent:${U(0x8000 + n)}`,
      occurredAtMs: T0,
    },
  };
}
