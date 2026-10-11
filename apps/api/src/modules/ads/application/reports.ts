import { sumStats, viewStats, type AdStatsView } from "../domain/bridge";
import type { AdsDeps } from "./shared";

export interface ReportView {
  readonly total: AdStatsView;
  readonly campaigns: readonly { readonly campaignId: string; readonly name: string; readonly stats: AdStatsView }[];
  readonly fromMs: number;
  readonly toMs: number;
}

/** Read model for the Seller Center: CTR, CPC and ROAS from integer arithmetic (half-even). */
export class GetAdReports {
  constructor(private readonly d: AdsDeps) {}

  async execute(i: { readonly storeId: string; readonly campaignId: string | null; readonly fromMs: number; readonly toMs: number }): Promise<ReportView> {
    const d = this.d;
    const campaigns = i.campaignId === null ? await d.store.listCampaigns(i.storeId, 100) : [];
    const one = async (campaignId: string | null) => {
      const s = await d.store.stats({ storeId: i.storeId, campaignId, fromMs: i.fromMs, toMs: i.toMs });
      const productIds = await d.store.productIdsFor(i.storeId, campaignId);
      const attributedRevenue =
        productIds.length === 0 ? 0n : await d.attribution.attributedRevenue({ storeId: i.storeId, productIds, fromMs: i.fromMs, toMs: i.toMs });
      return { ...s, attributedRevenue };
    };
    if (i.campaignId !== null) {
      const t = await one(i.campaignId);
      return { total: viewStats(t), campaigns: [], fromMs: i.fromMs, toMs: i.toMs };
    }
    const rows = await Promise.all(campaigns.map(async (c) => ({ c, row: await one(c.id) })));
    return {
      total: viewStats(sumStats(rows.map((r) => r.row))),
      campaigns: rows.map((r) => ({ campaignId: r.c.id, name: r.c.name, stats: viewStats(r.row) })),
      fromMs: i.fromMs,
      toMs: i.toMs,
    };
  }
}
