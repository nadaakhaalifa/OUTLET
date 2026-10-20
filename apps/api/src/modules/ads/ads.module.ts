import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { AdsClickReviewController } from "./adapters/click-review.controller";
import { AdsController } from "./adapters/ads.controller";
import {
  FakeAdsFlags,
  FakeAttribution,
  FakeBotScore,
  FakeChargeIntents,
  FakeEligibility,
  FakeEnforcement,
  FakeLedger,
  FakeSecret,
  InMemoryAdsStore,
} from "./adapters/in-memory";
import { AdsAdminResolver, CampaignResolver } from "./adapters/resolvers";
import { AdStoreAccess } from "./adapters/store-access";
import * as T from "./adapters/tokens";
import { ConfirmTopUp, FailTopUp, GetBalance, RequestTopUp } from "./application/billing";
import { CreditBackClick, PostClickSpend, RecordClick } from "./application/clicks";
import { ApplyEnforcement, ChangeCampaignStatus, CreateCampaign, EndExpiredCampaigns, GetCampaign, ListCampaigns, UpdateCampaign } from "./application/campaigns";
import { DecideInvalidClick, ListInvalidClicks } from "./application/click-review";
import { GetAdsConfig, PutAdsConfig } from "./application/config";
import { GetAdReports } from "./application/reports";
import { SelectSponsored } from "./application/selection";
import type { AdsDeps } from "./application/shared";
import type {
  AdsFlagsPort,
  AdsStore,
  AttributionPort,
  BotScorePort,
  ChargeIntentPort,
  EnforcementPort,
  LedgerPostingPort,
  ProductEligibilityPort,
  SecretPort,
} from "./domain/ports";

export interface AdsModuleOptions {
  /** Replaces the in-memory store (KyselyAdsStore) once persistence is wired. */
  readonly store?: AdsStore;
  readonly flags?: AdsFlagsPort;
  readonly enforcement?: EnforcementPort;
  readonly eligibility?: ProductEligibilityPort;
  readonly charges?: ChargeIntentPort;
  readonly ledger?: LedgerPostingPort;
  readonly bots?: BotScorePort;
  readonly attribution?: AttributionPort;
  readonly secret?: SecretPort;
  /** B-8: PSP name of the top-up collections, as in its settlement files. Default "ads". */
  readonly topUpPsp?: string;
}

/**
 * Thrown outside test mode when a port owned by another module is missing: money (charges, ledger),
 * the click-token key, the kill switch and price enforcement must never be development fixtures.
 */
export class MissingAdsPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`AdsModule requires real ${missing.join(", ")} outside test mode`);
    this.name = "MissingAdsPortsError";
  }
}

@Module({})
export class AdsModule {
  static forRoot(config: AppConfig, o: AdsModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.flags === undefined) missing.push("flags (kill.sponsored_products)");
      if (o.enforcement === undefined) missing.push("enforcement (price-integrity)");
      if (o.eligibility === undefined) missing.push("eligibility (catalog and search facts)");
      if (o.charges === undefined) missing.push("charges (payments B2B intents)");
      if (o.ledger === undefined) missing.push("ledger (double-entry postings)");
      if (o.bots === undefined) missing.push("bots (fraud score)");
      if (o.attribution === undefined) missing.push("attribution (orders)");
      if (o.secret === undefined) missing.push("secret (KMS HMAC key)");
      if (production && o.topUpPsp === undefined) missing.push("topUpPsp (clearing PSP name for top-up postings)");
      if (missing.length > 0) throw new MissingAdsPortsError(missing);
    }
    const store = o.store ?? new InMemoryAdsStore();
    const ports = {
      flags: o.flags ?? new FakeAdsFlags(),
      enforcement: o.enforcement ?? new FakeEnforcement(),
      eligibility: o.eligibility ?? new FakeEligibility(),
      charges: o.charges ?? new FakeChargeIntents(),
      ledger: o.ledger ?? new FakeLedger(),
      bots: o.bots ?? new FakeBotScore(),
      attribution: o.attribution ?? new FakeAttribution(),
      secret: o.secret ?? new FakeSecret(),
    };

    const runtime = (clock: Clock, ids: IdGenerator) => {
      const d: AdsDeps = { store, clock, ids, ...ports, ...(o.topUpPsp !== undefined ? { topUpPsp: o.topUpPsp } : production ? {} : { topUpPsp: "ads" }) };
      return {
        create: new CreateCampaign(d),
        update: new UpdateCampaign(d),
        status: new ChangeCampaignStatus(d),
        getOne: new GetCampaign(d),
        list: new ListCampaigns(d),
        enforce: new ApplyEnforcement(d),
        end: new EndExpiredCampaigns(d),
        topUp: new RequestTopUp(d),
        confirm: new ConfirmTopUp(d),
        fail: new FailTopUp(d),
        balance: new GetBalance(d),
        select: new SelectSponsored(d),
        click: new RecordClick(d),
        post: new PostClickSpend(d),
        creditBack: new CreditBackClick(d),
        reports: new GetAdReports(d),
        getConfig: new GetAdsConfig(d),
        putConfig: new PutAdsConfig(d),
        invalidClicks: new ListInvalidClicks(d),
        decideClick: new DecideInvalidClick(d),
      };
    };
    const RUNTIME = Symbol("ads.Runtime");
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({ provide: token, inject: [RUNTIME], useFactory: (r: Runtime) => pick(r) });

    return {
      module: AdsModule,
      controllers: [AdsController, AdsClickReviewController],
      providers: [
        AdStoreAccess,
        { provide: T.ADS_STORE, useValue: store },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids) },
        { provide: T.CAMPAIGN_RESOLVER, useValue: new CampaignResolver(store) },
        { provide: T.ADS_ADMIN_RESOLVER, useValue: new AdsAdminResolver() },
        from(T.CREATE_CAMPAIGN, (r) => r.create),
        from(T.UPDATE_CAMPAIGN, (r) => r.update),
        from(T.CHANGE_CAMPAIGN_STATUS, (r) => r.status),
        from(T.GET_CAMPAIGN, (r) => r.getOne),
        from(T.LIST_CAMPAIGNS, (r) => r.list),
        from(T.APPLY_ENFORCEMENT, (r) => r.enforce),
        from(T.END_EXPIRED_CAMPAIGNS, (r) => r.end),
        from(T.REQUEST_TOPUP, (r) => r.topUp),
        from(T.CONFIRM_TOPUP, (r) => r.confirm),
        from(T.FAIL_TOPUP, (r) => r.fail),
        from(T.GET_BALANCE, (r) => r.balance),
        from(T.SELECT_SPONSORED, (r) => r.select),
        from(T.RECORD_CLICK, (r) => r.click),
        from(T.LIST_INVALID_CLICKS, (r) => r.invalidClicks),
        from(T.DECIDE_INVALID_CLICK, (r) => r.decideClick),
        from(T.POST_CLICK_SPEND, (r) => r.post),
        from(T.CREDIT_BACK_CLICK, (r) => r.creditBack),
        from(T.GET_AD_REPORTS, (r) => r.reports),
        from(T.GET_ADS_CONFIG, (r) => r.getConfig),
        from(T.PUT_ADS_CONFIG, (r) => r.putConfig),
      ],
      exports: [
        T.ADS_STORE,
        T.SELECT_SPONSORED,
        T.RECORD_CLICK,
        T.CONFIRM_TOPUP,
        T.FAIL_TOPUP,
        T.APPLY_ENFORCEMENT,
        T.END_EXPIRED_CAMPAIGNS,
        T.POST_CLICK_SPEND,
        T.CREDIT_BACK_CLICK,
      ],
    };
  }
}
