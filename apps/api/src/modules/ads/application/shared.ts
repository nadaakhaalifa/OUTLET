import { createHash, timingSafeEqual } from "node:crypto";
import { DEFAULT_ADS_CONFIG, type AdsConfig, type TargetingContext } from "../domain/bridge";
import type {
  AdsFlagsPort,
  AdsStore,
  AttributionPort,
  BotScorePort,
  ChargeIntentPort,
  Clock,
  EnforcementPort,
  IdPort,
  LedgerPostingPort,
  ProductEligibilityPort,
  SecretPort,
} from "../domain/ports";

export interface AdsDeps {
  readonly store: AdsStore;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly flags: AdsFlagsPort;
  readonly enforcement: EnforcementPort;
  readonly eligibility: ProductEligibilityPort;
  readonly charges: ChargeIntentPort;
  readonly ledger: LedgerPostingPort;
  readonly bots: BotScorePort;
  readonly attribution: AttributionPort;
  readonly secret: SecretPort;
  /** B-8: PSP name in settlement files. No default: unset fails closed. */
  readonly topUpPsp?: string;
}

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const configOf = async (d: AdsDeps): Promise<AdsConfig> => (await d.store.getConfig()) ?? DEFAULT_ADS_CONFIG;

/** Validation-only context for ownership checks: carries no shopper attribute at all. */
export const NEUTRAL_CONTEXT: TargetingContext = { query: null, categoryIds: [], storeScope: null, locale: "ar" };

export const dayMs = 86_400_000;
