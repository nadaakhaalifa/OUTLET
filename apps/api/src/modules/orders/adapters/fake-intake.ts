import { money, type Money } from "../domain/bridge";
import type { PlaceOrders, PlaceOrdersInput } from "../application/intake";

/**
 * Stand-in for the checkout saga (out of scope for this wave). Builds a valid hand-over and calls
 * the real `PlaceOrders` use case. Test and development use only.
 */
export interface FakeOrderSpec {
  readonly groupId: string;
  readonly userId: string;
  readonly idempotencyKey?: string;
  readonly paymentMethod?: PlaceOrdersInput["paymentMethod"];
  readonly paidAtMs: number;
  readonly stores: readonly {
    readonly sellerOrderId: string;
    readonly storeId: string;
    readonly lines?: number;
    readonly unitPrice?: Money;
    readonly shipping?: Money;
    readonly commissionRateBps?: number;
    readonly firstName?: string | null;
    readonly phoneRelay?: string | null;
  }[];
}

export class FakeOrderIntake {
  private seq = 0;
  constructor(private readonly place: PlaceOrders) {}

  private id(kind: number): string {
    this.seq += 1;
    return `0192f3a4-5b6c-7d8e-${String(kind).padStart(4, "0")}-${String(this.seq).padStart(12, "0")}`;
  }

  async placeOrder(spec: FakeOrderSpec) {
    return this.place.execute({
      groupId: spec.groupId,
      userId: spec.userId,
      idempotencyKey: spec.idempotencyKey ?? `fake-${spec.groupId}`,
      paymentMethod: spec.paymentMethod ?? "card",
      paidAtMs: spec.paidAtMs,
      storeCredit: money(0n),
      sellerOrders: spec.stores.map((s) => ({
        id: s.sellerOrderId,
        storeId: s.storeId,
        commissionRateBps: s.commissionRateBps ?? 1_500,
        shipping: s.shipping ?? money(4_000n),
        discount: money(0n),
        vat: money(0n),
        buyer: {
          firstName: s.firstName === undefined ? "Mona" : s.firstName,
          phoneRelay: s.phoneRelay === undefined ? "+20100000099" : s.phoneRelay,
          governorateCode: "EG-C",
        },
        lines: Array.from({ length: s.lines ?? 1 }, (_, i) => ({
          id: this.id(1 + i),
          skuId: this.id(2),
          productId: this.id(3),
          qty: 1 + i,
          unitPrice: s.unitPrice ?? money(25_000n),
          discountAlloc: money(0n),
          vat: money(0n),
          title: { ar: "فستان كتان", en: "Linen dress" },
          sizeLabel: "M",
        })),
      })),
    });
  }
}
