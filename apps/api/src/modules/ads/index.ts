/** Public surface of the ads module (A2.3). Other code imports only this file. */
export { AdsModule, MissingAdsPortsError, type AdsModuleOptions } from "./ads.module";
export {
  ADS_STORE,
  SELECT_SPONSORED,
  RECORD_CLICK,
  CONFIRM_TOPUP,
  FAIL_TOPUP,
  APPLY_ENFORCEMENT,
  END_EXPIRED_CAMPAIGNS,
  POST_CLICK_SPEND,
  CREDIT_BACK_CLICK,
} from "./adapters/tokens";
export {
  InMemoryAdsStore,
  FakeAdsFlags,
  FakeAttribution,
  FakeBotScore,
  FakeChargeIntents,
  FakeEligibility,
  FakeEnforcement,
  FakeLedger,
  FakeSecret,
} from "./adapters/in-memory";
export { KyselyAdsStore, type AdsDb } from "./adapters/kysely-store";
export { markSponsored, servableSelections } from "./adapters/search-bridge";
export { SelectSponsored, type SponsoredSelection } from "./application/selection";
export { RecordClick, PostClickSpend, CreditBackClick } from "./application/clicks";
export { ConfirmTopUp, FailTopUp } from "./application/billing";
export { ApplyEnforcement, EndExpiredCampaigns } from "./application/campaigns";
export type {
  AdsFlagsPort,
  AdsStore,
  AttributionPort,
  BotScorePort,
  ChargeIntentPort,
  EnforcementPort,
  LedgerPostingPort,
  ProductAdFacts,
  ProductEligibilityPort,
  SecretPort,
} from "./domain/ports";
