import type { AdsConfig } from "../domain/bridge";
import { configOf, type AdsDeps } from "./shared";

export class GetAdsConfig {
  constructor(private readonly d: AdsDeps) {}
  execute(): Promise<AdsConfig> {
    return configOf(this.d);
  }
}

export type PutConfigResult = { readonly kind: "ok"; readonly config: AdsConfig } | { readonly kind: "invalid"; readonly field: string };

export class PutAdsConfig {
  constructor(private readonly d: AdsDeps) {}

  async execute(actorId: string, next: AdsConfig): Promise<PutConfigResult> {
    const bad = (field: string): PutConfigResult => ({ kind: "invalid", field });
    if (next.floorPrice <= 0n) return bad("floor_price");
    if (!Number.isInteger(next.slots) || next.slots < 0 || next.slots > 4) return bad("slots");
    if (next.minTopUp <= 0n || next.maxTopUp < next.minTopUp) return bad("top_up_range");
    if (next.vatBps < 0n || next.vatBps > 10_000n) return bad("vat_bps");
    if (next.botScoreBlockBps < 0 || next.botScoreBlockBps > 10_000) return bad("bot_score_block_bps");
    await this.d.store.putConfig(next, actorId);
    return { kind: "ok", config: next };
  }
}
