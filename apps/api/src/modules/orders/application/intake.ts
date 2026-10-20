import type { Clock } from "../../../platform/ports";
import {
  acceptDeadline,
  assertValidIntake,
  type Money,
  type PaymentType,
} from "../domain/bridge";
import type {
  BuyerContactRecord,
  LocalizedText,
  NewOrderGroup,
  OrderIntake,
  PaymentMethodCode,
  OrderRepository,
} from "../domain/ports";

/** What checkout hands over after payment or COD confirmation. Deadlines are computed here, not by the caller. */
export interface PlaceOrdersInput {
  readonly groupId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly paymentMethod: PaymentMethodCode;
  readonly paidAtMs: number;
  readonly storeCredit: Money;
  readonly sellerOrders: readonly {
    readonly id: string;
    readonly storeId: string;
    readonly commissionRateBps: number;
    readonly shipping: Money;
    readonly discount: Money;
    readonly vat: Money;
    readonly lines: readonly {
      readonly id: string;
      readonly skuId: string;
      readonly productId: string;
      readonly qty: number;
      readonly unitPrice: Money;
      readonly discountAlloc: Money;
      readonly vat: Money;
      readonly title: LocalizedText;
      readonly sizeLabel?: string;
    }[];
    readonly buyer: BuyerContactRecord;
  }[];
}

export class PlaceOrders {
  constructor(
    private readonly intake: OrderIntake & Pick<OrderRepository, "place">,
    private readonly clock: Clock,
  ) {}

  async execute(i: PlaceOrdersInput): Promise<{ kind: "created" | "duplicate"; groupId: string }> {
    const paymentType: PaymentType = i.paymentMethod === "cod" ? "cod" : "prepaid";
    const zero = { amount: 0n, currency: "EGP" } as const satisfies Money;
    const sellerOrders: NewOrderGroup["sellerOrders"] = i.sellerOrders.map((so) => {
      const subtotal = so.lines.reduce<Money>(
        (acc, l) => ({ amount: acc.amount + l.unitPrice.amount * BigInt(l.qty), currency: "EGP" }),
        zero,
      );
      const total: Money = { amount: subtotal.amount + so.shipping.amount - so.discount.amount, currency: "EGP" };
      assertValidIntake(so.lines, { subtotal, shipping: so.shipping, discount: so.discount, total });
      return {
        id: so.id,
        storeId: so.storeId,
        status: paymentType === "cod" ? ("CONFIRMED_COD" as const) : ("PAID" as const),
        paidAtMs: i.paidAtMs,
        acceptByMs: acceptDeadline(i.paidAtMs),
        subtotal,
        shipping: so.shipping,
        discount: so.discount,
        vat: so.vat,
        total,
        commissionRateBps: so.commissionRateBps,
        lines: so.lines,
        buyer: so.buyer,
      };
    });
    const sum = (f: (s: NewOrderGroup["sellerOrders"][number]) => bigint): Money => ({
      amount: sellerOrders.reduce((a, s) => a + f(s), 0n),
      currency: "EGP",
    });
    const group: NewOrderGroup = {
      id: i.groupId,
      userId: i.userId,
      idempotencyKey: i.idempotencyKey,
      paymentMethod: i.paymentMethod,
      paymentType,
      subtotal: sum((s) => s.subtotal.amount),
      shipping: sum((s) => s.shipping.amount),
      discount: sum((s) => s.discount.amount),
      vat: sum((s) => s.vat.amount),
      storeCredit: i.storeCredit,
      total: sum((s) => s.total.amount),
      placedAtMs: this.clock.nowMs(),
      sellerOrders,
    };
    return this.intake.place(group);
  }
}
