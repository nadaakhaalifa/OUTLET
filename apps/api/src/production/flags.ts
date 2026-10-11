import {
  FlagClient,
  isKnownFlag,
  type EvaluationContext,
  type FlagKey,
  type FlagProvider,
  type ResolutionDetails,
} from "../../../../packages/feature-flags/src/index";
import { FlagPaymentMethodSwitch } from "../modules/payments";
import { markUnconfigured } from "./unconfigured";
import type { CheckoutMethod } from "../modules/checkout";

/**
 * Flag provider for deployments with no flag backend. Every evaluation reports PROVIDER_NOT_READY
 * with the registry default, and the registry default is `false`: every kill switch is BLOCKED
 * (ADR-0028 polarity) until an operator both configures a provider and enables the switch.
 */
export class UnconfiguredFlagProvider implements FlagProvider {
  readonly metadata = { name: "unconfigured" } as const;
  readonly runsOn = "server" as const;
  private notReady<T>(value: T): ResolutionDetails<T> {
    return { value, reason: "ERROR", errorCode: "PROVIDER_NOT_READY" };
  }
  resolveBooleanEvaluation(_k: string, d: boolean, _c: EvaluationContext): ResolutionDetails<boolean> {
    return this.notReady(d);
  }
  resolveStringEvaluation(_k: string, d: string, _c: EvaluationContext): ResolutionDetails<string> {
    return this.notReady(d);
  }
  resolveNumberEvaluation(_k: string, d: number, _c: EvaluationContext): ResolutionDetails<number> {
    return this.notReady(d);
  }
}

/** Every port below answers from the registry; an unknown or unconfigured key is `false` (blocked). */
export interface ProductionFlagPorts {
  readonly client: FlagClient;
  readonly paymentMethodSwitch: FlagPaymentMethodSwitch;
  readonly isEnabled: (key: string) => Promise<boolean>;
  readonly hub: { consolidationEnabled(): Promise<boolean> };
  readonly resale: { listingEnabled(): Promise<boolean> };
  readonly crawl: { crawlingEnabled(): Promise<boolean> };
  readonly ads: { sponsoredEnabled(): Promise<boolean> };
  readonly gift: { salesEnabled(): Promise<boolean>; redemptionEnabled(): Promise<boolean> };
  readonly budget: { suiteEnabled(): Promise<boolean>; capsEnabled(): Promise<boolean> };
  readonly mlRanking: { mlRankingAllowed(): Promise<boolean> };
  readonly rewards: { gamesEnabled(): Promise<boolean>; coinsEnabled(): Promise<boolean> };
  readonly switches: { allowed(key: string): Promise<boolean> };
  readonly gate: { enabled(key: string): Promise<boolean>; isEnabled(key: string): Promise<boolean> };
  readonly search: { typesenseDisabled(): Promise<boolean> };
  /** Capabilities with no registry key yet: blocked by construction. */
  readonly payouts: { payoutsEnabled(): Promise<boolean> };
  readonly recon: { intradayEnabled(): Promise<boolean> };
  readonly checkoutKill: { disabledMethods(): Promise<ReadonlySet<CheckoutMethod>> };
}

export function createProductionFlags(provider: FlagProvider = new UnconfiguredFlagProvider()): ProductionFlagPorts {
  if (provider instanceof UnconfiguredFlagProvider) markUnconfigured("flags.provider");
  const client = new FlagClient({ provider });
  const isEnabled = async (key: string): Promise<boolean> => (isKnownFlag(key) ? client.isEnabled(key) : false);
  const on = (key: FlagKey): (() => Promise<boolean>) => () => client.isEnabled(key);
  const switchKey = (k: string): string => {
    if (k === "drops_all") return "kill.drops";
    if (k.startsWith("drop_type_")) return `kill.drop_type.${k.slice("drop_type_".length)}`;
    return `kill.${k}`;
  };
  return {
    client,
    paymentMethodSwitch: new FlagPaymentMethodSwitch(client),
    isEnabled,
    hub: { consolidationEnabled: on("kill.hub_consolidation") },
    resale: { listingEnabled: on("kill.resale_lane") },
    crawl: { crawlingEnabled: on("kill.crawlers") },
    ads: { sponsoredEnabled: on("kill.sponsored_products") },
    gift: { salesEnabled: on("kill.gift_card_sales"), redemptionEnabled: on("kill.gift_card_redemption") },
    budget: { suiteEnabled: on("release.budget_suite"), capsEnabled: on("kill.budget_caps") },
    mlRanking: { mlRankingAllowed: on("kill.ml_ranking") },
    rewards: { gamesEnabled: on("kill.games"), coinsEnabled: on("kill.rewards_coins") },
    switches: { allowed: (k) => isEnabled(switchKey(k)) },
    gate: { enabled: isEnabled, isEnabled },
    search: { typesenseDisabled: async () => !(await client.isEnabled("kill.search_engine")) },
    payouts: { payoutsEnabled: async () => false },
    recon: { intradayEnabled: async () => false },
    checkoutKill: {
      // Method-level kill switches are enforced by the payments module (PaymentMethodSwitch); the
      // checkout view lists every external method as disabled until its family switch is allowed.
      disabledMethods: async () => {
        const out = new Set<CheckoutMethod>();
        if (!(await client.isEnabled("kill.payment.card"))) {
          out.add("card");
          out.add("meeza");
        }
        if (!(await client.isEnabled("kill.payment.apple_pay"))) out.add("apple_pay");
        if (!(await client.isEnabled("kill.payment.mobile_wallet"))) out.add("mobile_wallet");
        if (!(await client.isEnabled("kill.payment.instapay"))) out.add("instapay");
        if (!(await client.isEnabled("kill.payment.fawry"))) out.add("fawry");
        if (!(await client.isEnabled("kill.payment.cod"))) out.add("cod");
        if (!(await client.isEnabled("kill.payment.bnpl"))) out.add("bnpl");
        return out;
      },
    },
  };
}
