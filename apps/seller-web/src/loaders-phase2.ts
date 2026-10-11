/** Phase 2 screen loaders (same contract as loaders.ts: API result -> serialisable view model -> ScreenState). */
import type { Ctx } from "./loaders";
import { formatDateTime } from "./lib/format";
import { balanceSummary, campaignRows, reportTiles, type BalanceVM, type CampaignRowVM, type StatTile } from "./view-models/ads";
import { defaultRange } from "./view-models/analytics";
import { channelRows, incidents, parityWarnings, type ChannelRowVM, type IncidentVM, type ParityWarningVM } from "./view-models/channels";
import { dropRows, type DropRowVM } from "./view-models/drops";
import { hubRows, type HubVM } from "./view-models/hub";
import { markdownRows, sizeCurveRows, type MarkdownRowVM, type SizeCurveVM } from "./view-models/insights";
import { resaleRows, type ResaleRowVM } from "./view-models/resale";
import { stateFromError, stateFromResult, type ScreenState } from "./view-models/screen-state";

const notConfigured: ScreenState<never> = { kind: "not_configured" };

/* ---------------- sponsored products ---------------- */
export interface AdsVM {
  readonly storeId: string;
  readonly campaigns: readonly CampaignRowVM[];
  readonly balance: BalanceVM | null;
  readonly tiles: readonly StatTile[] | null;
  readonly perCampaign: readonly { readonly id: string; readonly name: string; readonly tiles: readonly StatTile[] }[];
  readonly period: string | null;
}

export async function loadAds(c: Ctx): Promise<ScreenState<AdsVM>> {
  if (c.api === null) return notConfigured;
  const store = await c.api.store();
  if (!store.ok) return stateFromError(store.error);
  const storeId = store.value.data.id;
  const [campaigns, balance, report] = await Promise.all([
    c.api.adCampaigns(storeId), c.api.adBalance(storeId), c.api.adReport(storeId, defaultRange(c.nowMs)),
  ]);
  if (!campaigns.ok) return stateFromError(campaigns.error);
  const items = campaigns.value.data.items;
  const rep = report.ok ? report.value.data : null;
  return {
    kind: "ready",
    serverNowMs: campaigns.value.serverNowMs,
    data: {
      storeId,
      campaigns: campaignRows(items, c.locale),
      balance: balance.ok ? balanceSummary(balance.value.data, items, c.locale) : null,
      tiles: rep === null ? null : reportTiles(rep.total, c.locale),
      perCampaign: rep === null ? [] : rep.campaigns.map((x) => ({ id: x.campaign_id, name: x.name, tiles: reportTiles(x, c.locale) })),
      period: rep === null ? null : `${formatDateTime(rep.from, c.locale)} - ${formatDateTime(rep.to, c.locale)}`,
    },
  };
}

/* ---------------- drops ---------------- */
export interface DropsVM {
  readonly storeId: string | null;
  readonly rows: readonly DropRowVM[];
  readonly nextCursor: string | null;
}
export async function loadDrops(c: Ctx, cursor?: string): Promise<ScreenState<DropsVM>> {
  if (c.api === null) return notConfigured;
  const r = await c.api.listDrops(cursor);
  if (!r.ok) return stateFromError(r.error);
  const p = r.value.data;
  return {
    kind: "ready",
    serverNowMs: r.value.serverNowMs,
    data: { storeId: p.items[0]?.store_id ?? null, rows: dropRows(p.items, c.locale), nextCursor: p.page.has_more ? (p.page.next_cursor ?? null) : null },
  };
}

/* ---------------- resale ---------------- */
export interface ResaleVM { readonly storeId: string; readonly rows: readonly ResaleRowVM[] }
export async function loadResale(c: Ctx): Promise<ScreenState<ResaleVM>> {
  if (c.api === null) return notConfigured;
  const store = await c.api.store();
  if (!store.ok) return stateFromError(store.error);
  const storeId = store.value.data.id;
  const r = await c.api.resaleListings(storeId);
  return stateFromResult(r, (d): ResaleVM => ({ storeId, rows: resaleRows(d.items, c.locale) }));
}

/* ---------------- analytics v2 ---------------- */
export interface InsightsVM {
  readonly kMin: number;
  readonly asOf: string | null;
  readonly markdown: readonly MarkdownRowVM[] | null;
  readonly sizeCurve: readonly SizeCurveVM[] | null;
}
export async function loadInsights(c: Ctx): Promise<ScreenState<InsightsVM>> {
  if (c.api === null) return notConfigured;
  const store = await c.api.store();
  if (!store.ok) return stateFromError(store.error);
  const storeId = store.value.data.id;
  const range = defaultRange(c.nowMs);
  const [aging, curve] = await Promise.all([c.api.agingReport(storeId, range), c.api.sizeCurve(storeId, range)]);
  if (!aging.ok && !curve.ok) return stateFromError(aging.error);
  const meta = aging.ok ? aging.value.data.meta : curve.ok ? curve.value.data.meta : null;
  return {
    kind: "ready",
    serverNowMs: aging.ok ? aging.value.serverNowMs : curve.ok ? curve.value.serverNowMs : null,
    data: {
      kMin: meta?.k_anonymity_min ?? 0,
      asOf: meta === null || meta.freshness.as_of === null ? null : formatDateTime(meta.freshness.as_of, c.locale),
      markdown: aging.ok ? markdownRows(aging.value.data, c.locale) : null,
      sizeCurve: curve.ok ? sizeCurveRows(curve.value.data, c.locale) : null,
    },
  };
}

/* ---------------- price trust: channels, incidents, parity ---------------- */
export interface ChannelsVM {
  readonly storeId: string;
  readonly channels: readonly ChannelRowVM[];
  readonly incidents: readonly IncidentVM[];
  readonly parity: readonly ParityWarningVM[];
}
export async function loadChannels(c: Ctx): Promise<ScreenState<ChannelsVM>> {
  if (c.api === null) return notConfigured;
  const store = await c.api.store();
  if (!store.ok) return stateFromError(store.error);
  const storeId = store.value.data.id;
  const [channels, targets, trust] = await Promise.all([c.api.channels(), c.api.crawlTargets(storeId), c.api.priceTrust()]);
  if (!channels.ok) return stateFromError(channels.error);
  const ch = channels.value.data.items;
  const tg = targets.ok ? targets.value.data.items : [];
  return {
    kind: "ready",
    serverNowMs: trust.ok ? trust.value.serverNowMs : channels.value.serverNowMs,
    data: {
      storeId,
      channels: channelRows(ch, c.locale),
      incidents: incidents(ch, tg),
      parity: trust.ok ? parityWarnings(trust.value.data.active_actions, c.locale) : [],
    },
  };
}

/* ---------------- hub consolidation (read only) ---------------- */
export async function loadHub(c: Ctx, orderGroupId: string): Promise<ScreenState<HubVM>> {
  if (c.api === null) return notConfigured;
  const r = await c.api.hubTracking(orderGroupId);
  return stateFromResult(r, (d) => hubRows(d, c.locale), (v) => v.parcels.length === 0 && !v.hasWaiting);
}
