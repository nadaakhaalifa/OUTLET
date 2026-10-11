/** Public surface of the gift-cards module (A2.3). Other code imports only this file. */
export { GiftCardsModule, MissingGiftCardPortsError, type GiftCardsModuleOptions } from "./gift-cards.module";
export {
  GIFT_CARD_STORE,
  ISSUE_ON_PAYMENT,
  CANCEL_UNPAID_CARD,
  CONFIRM_DELIVERED,
  EXPIRE_GIFT_CARDS,
  CONFIRM_CONTRIBUTION,
  CLOSE_DUE_POTS,
  RESUME_PENDING_REDEMPTIONS,
} from "./adapters/tokens";
export {
  InMemoryGiftCardStore,
  FakeSecret,
  FakeStoreCredit,
  FakeAudit,
  FakeFlags,
  FakeAgeGate,
  FakePayments,
  FakeDelivery,
  DevAesGcmFieldCipher,
  NodeRandom,
  SequenceRandom,
} from "./adapters/in-memory";
export { KyselyGiftCardStore, type GiftCardDb } from "./adapters/kysely-store";
export { PurchaseGiftCard, IssueOnPayment, CancelUnpaidCard, ConfirmDelivered, VoidGiftCard, ExpireGiftCards } from "./application/purchase";
export { RedeemGiftCard, ResumePendingRedemptions, settleRedemption } from "./application/redeem";
export { StoreCreditRejectedError } from "./domain/ports";
export { ClosePot, CloseDuePots, ConfirmContribution, RefundUnfundedPot } from "./application/pots";
export type {
  AgeGatePort,
  AuditPort,
  DeliveryPort,
  FieldCipherPort,
  GiftCardFlagsPort,
  GiftCardStore,
  PaymentIntentPort,
  RandomPort,
  SecretPort,
  StoreCreditPort,
} from "./domain/ports";
