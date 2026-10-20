import { disputeMachine, type DisputeContext } from "./machines/dispute";
import { dropMachine } from "./machines/drop";
import { giftCardMachine, type GiftCardContext } from "./machines/gift-card";
import { kycMachine, type KycContext } from "./machines/kyc";
import { orderGroupMachine, type OrderGroupContext } from "./machines/order-group";
import { payoutMachine, type PayoutContext } from "./machines/payout";
import { priceClaimMachine } from "./machines/price-claim";
import { priceDropAutoBuyMachine, type AutoBuyContext } from "./machines/price-drop-auto-buy";
import { refundMachine, type RefundContext } from "./machines/refund";
import { returnMachine, type ReturnContext } from "./machines/return";
import { sellerOrderMachine, type SellerOrderContext } from "./machines/seller-order";
import { shipmentMachine, type ShipmentContext } from "./machines/shipment";
import { subscriptionMachine } from "./machines/subscription";
import type { StateMachine } from "./machine";

/** The 13 machines named in spec A2.6, keyed by a stable identifier. */
export const stateMachines = {
  orderGroup: orderGroupMachine,
  sellerOrder: sellerOrderMachine,
  shipment: shipmentMachine,
  return: returnMachine,
  refund: refundMachine,
  payout: payoutMachine,
  subscription: subscriptionMachine,
  drop: dropMachine,
  priceClaim: priceClaimMachine,
  giftCard: giftCardMachine,
  kyc: kycMachine,
  dispute: disputeMachine,
  priceDropAutoBuy: priceDropAutoBuyMachine,
} as const;

export type StateMachineKey = keyof typeof stateMachines;

export type {
  AutoBuyContext,
  DisputeContext,
  GiftCardContext,
  KycContext,
  OrderGroupContext,
  PayoutContext,
  RefundContext,
  ReturnContext,
  SellerOrderContext,
  ShipmentContext,
  StateMachine,
};
