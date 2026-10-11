/** Public surface of the referrals module. Other code imports only this file (A2.3). */
export { ReferralsModule, type ReferralsModuleOptions } from "./referrals.module";
export {
  ATTRIBUTE_REFERRAL,
  GET_MY_REFERRAL,
  HANDLE_ORDER_CLOSED,
  QUOTE_REFEREE_OFFER,
  REFERRAL_APP_ATTEST,
  REFERRAL_IDENTITY,
  REFERRAL_STORE,
} from "./adapters/tokens";
export { InMemoryAppAttest, InMemoryReferralIdentity, InMemoryReferralStore } from "./adapters/in-memory";
export { KyselyReferralStore, type ReferralDb } from "./adapters/kysely-store";
export { ORDER_CLOSED_CONSUMER } from "./application/referrals";
export type { HandleOrderClosed, QuoteRefereeOffer } from "./application/referrals";
export type {
  AppAttestPort,
  OrderClosedMessage,
  PartyProfileView,
  ReferralEvent,
  ReferralIdentityPort,
  ReferralStore,
} from "./domain/ports";
