import type { AdBalance, AdCampaign, AdReport } from "../api/schemas-phase2";
import type { AdCampaignInput } from "../api/client";
import type { Locale, MessageKey } from "../i18n";
import { cairoLocalToIso } from "../lib/cairo-time";
import { formatBps, formatDateTime, formatInt, formatMoney } from "../lib/format";
import { formatRatioBps, parseEgpToMinor } from "../lib/money-input";

const KNOWN_STATUS = new Set(["draft", "active", "paused", "ended", "exhausted", "blocked"]);
export const statusKey = (s: string): MessageKey => (KNOWN_STATUS.has(s.toLowerCase()) ? (`ads.status.${s.toLowerCase()}` as MessageKey) : "ads.status.unknown");

export interface CampaignRowVM {
  readonly id: string;
  readonly name: string;
  readonly statusKey: MessageKey;
  readonly dailyBudget: string;
  readonly maxCpc: string;
  readonly bids: string;
  readonly period: string;
  readonly canPause: boolean;
  readonly canResume: boolean;
}

export function campaignRows(items: readonly AdCampaign[], locale: Locale): readonly CampaignRowVM[] {
  return items.map((c) => ({
    id: c.id,
    name: c.name,
    statusKey: statusKey(c.status),
    dailyBudget: formatMoney(c.daily_budget.minor, locale),
    maxCpc: formatMoney(c.max_cpc.minor, locale),
    bids: formatInt(c.bids.length, locale),
    period: `${c.starts_at === null ? "" : formatDateTime(c.starts_at, locale)}${c.ends_at === null ? "" : ` - ${formatDateTime(c.ends_at, locale)}`}`.trim(),
    canPause: c.status.toLowerCase() === "active",
    canResume: c.status.toLowerCase() === "paused",
  }));
}

export interface StatTile { readonly id: string; readonly labelKey: MessageKey; readonly value: string | null }

/** null means "no value" (no clicks or no spend): shown as not-enough-data, never as zero. */
export function reportTiles(t: AdReport["total"], locale: Locale): readonly StatTile[] {
  return [
    { id: "impressions", labelKey: "ads.impressions", value: formatInt(t.impressions, locale) },
    { id: "clicks", labelKey: "ads.clicks", value: formatInt(t.clicks, locale) },
    { id: "ctr", labelKey: "ads.ctr", value: t.impressions === 0 ? null : formatBps(t.ctr_bp, locale) },
    { id: "cpc", labelKey: "ads.cpc", value: t.cpc === null ? null : formatMoney(t.cpc.minor, locale) },
    { id: "spend", labelKey: "ads.spend", value: formatMoney(t.spend.minor, locale) },
    { id: "revenue", labelKey: "ads.revenue", value: formatMoney(t.attributed_revenue.minor, locale) },
    { id: "roas", labelKey: "ads.roas", value: t.roas_bp === null ? null : formatRatioBps(BigInt(t.roas_bp), locale) },
  ];
}

export interface BalanceVM {
  readonly balance: string;
  readonly activeDailyCaps: string;
  /** True when the balance is below the sum of active daily caps: campaigns may stop mid-day. */
  readonly belowDailyCaps: boolean;
  readonly topUps: readonly { readonly id: string; readonly status: string; readonly net: string; readonly vat: string; readonly gross: string }[];
}

export function balanceSummary(b: AdBalance, campaigns: readonly AdCampaign[], locale: Locale): BalanceVM {
  const caps = campaigns.filter((c) => c.status.toLowerCase() === "active").reduce((sum, c) => sum + c.daily_budget.minor, 0n);
  return {
    balance: formatMoney(b.balance.minor, locale),
    activeDailyCaps: formatMoney(caps, locale),
    belowDailyCaps: caps > 0n && b.balance.minor < caps,
    topUps: b.top_ups.map((x) => ({
      id: x.id, status: x.status, net: formatMoney(x.net.minor, locale), vat: formatMoney(x.vat.minor, locale), gross: formatMoney(x.gross.minor, locale),
    })),
  };
}

/** Rules the ad surface must follow (master prompt section 4 and 19). Rendered as a static, translated checklist. */
export const SPONSORED_RULES: readonly MessageKey[] = ["ads.rule.label", "ads.rule.cap", "ads.rule.filters", "ads.rule.blocked"];

export interface CampaignDraft {
  readonly storeId: string;
  readonly name: string;
  readonly dailyBudget: string;
  readonly maxCpc: string;
  readonly startsAtLocal: string;
  readonly endsAtLocal: string;
  readonly productId: string;
  readonly bid: string;
  readonly keywords: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DraftResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly errors: readonly MessageKey[] };

export function validateCampaign(d: CampaignDraft): DraftResult<AdCampaignInput> {
  const errors: MessageKey[] = [];
  const name = d.name.trim();
  if (name.length < 2 || name.length > 80) errors.push("ads.err.name");
  const budget = parseEgpToMinor(d.dailyBudget);
  const cpc = parseEgpToMinor(d.maxCpc);
  const bid = parseEgpToMinor(d.bid);
  if (budget === null) errors.push("ads.err.budget");
  if (cpc === null) errors.push("ads.err.cpc");
  if (bid === null) errors.push("ads.err.bid");
  if (budget !== null && cpc !== null && BigInt(cpc) > BigInt(budget)) errors.push("ads.err.cpcAboveBudget");
  if (!UUID.test(d.productId.trim())) errors.push("ads.err.product");
  if (!UUID.test(d.storeId)) errors.push("state.error");
  const start = cairoLocalToIso(d.startsAtLocal);
  const end = d.endsAtLocal.trim() === "" ? null : cairoLocalToIso(d.endsAtLocal);
  if (start === null) errors.push("ads.err.start");
  if (d.endsAtLocal.trim() !== "" && end === null) errors.push("ads.err.end");
  if (start !== null && end !== null && Date.parse(end) <= Date.parse(start)) errors.push("ads.err.endBeforeStart");
  const keywords = d.keywords.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
  if (keywords.length > 20 || keywords.some((k) => k.length > 60)) errors.push("ads.err.keywords");
  if (errors.length > 0 || budget === null || cpc === null || bid === null || start === null) return { ok: false, errors };
  return {
    ok: true,
    value: {
      store_id: d.storeId, name, daily_budget: { amount: budget, currency: "EGP" }, max_cpc: { amount: cpc, currency: "EGP" },
      starts_at: start, ends_at: end, keywords, bids: [{ product_id: d.productId.trim(), bid: { amount: bid, currency: "EGP" } }],
    },
  };
}
