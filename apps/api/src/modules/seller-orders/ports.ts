import type { CourierPort, StructuredAddress } from "@outlet/shipping";

/** Delivery data of one order as the buyer gave it (P2/P3). The seller sees it only through `SellerOrderService`, which gates and masks it. */
export interface BuyerDelivery {
  readonly recipientName: string;
  /** Raw E.164; the service masks it before it leaves the API. */
  readonly phone: string;
  readonly address: StructuredAddress;
  /** When the seller loses access (30 days after delivery or return closure); null while the order is live. */
  readonly accessUntil: Date | null;
}

/** The addresses table is not built yet: production answers null for every order (no delivery data is shown or invented). */
export interface BuyerDeliveryPort {
  forSellerOrder(input: { readonly storeId: string; readonly sellerOrderId: string }): Promise<BuyerDelivery | null>;
}

export type PaymentKind = "prepaid" | "cod";

/** How the shopper pays decides the COD amount the courier collects. Unknown is never guessed. */
export interface PaymentKindPort {
  kindOf(input: { readonly userId: string; readonly orderGroupId: string }): Promise<PaymentKind | null>;
}

export interface SellerOrdersServicesDeps {
  readonly delivery: BuyerDeliveryPort;
  readonly courier: CourierPort;
  readonly paymentKinds: PaymentKindPort;
  /** Courier code and service level recorded on the request (Bosta first, once contracted). */
  readonly courierCode: string;
  readonly serviceLevel: string;
}
