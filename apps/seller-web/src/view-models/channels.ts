import type { ChannelConnection, ChannelType, CrawlTarget } from "../api/schemas-phase2";
import type { PriceTrust } from "../api/schemas";
import type { Locale, MessageKey } from "../i18n";
import { formatDateTime } from "../lib/format";

/** Shop domain: bare hostname only, lower-cased. No scheme, path, port, credentials or IP literals (open-redirect/SSRF guard). */
export function normaliseShopDomain(input: string): string | null {
  const d = input.trim().toLowerCase();
  if (d.length > 253 || !/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) return null;
  return d;
}

export interface ChannelRowVM {
  readonly id: string;
  readonly type: ChannelType;
  readonly domain: string;
  readonly statusKey: MessageKey;
  readonly lastSnapshot: string | null;
  readonly needsAttention: boolean;
}

export function channelRows(items: readonly ChannelConnection[], locale: Locale): readonly ChannelRowVM[] {
  return items.map((c) => ({
    id: c.id,
    type: c.type,
    domain: c.shop_domain,
    statusKey: `channels.status.${c.status}` as MessageKey,
    lastSnapshot: c.last_snapshot_at === undefined || c.last_snapshot_at === null ? null : formatDateTime(c.last_snapshot_at, locale),
    needsAttention: c.status === "revoked" || c.status === "error",
  }));
}

export interface IncidentVM {
  readonly id: string;
  readonly kind: "channel" | "crawl";
  readonly subject: string;
  readonly reasonKey: MessageKey;
}

/**
 * The API has no incident feed, so incidents are derived from read models only:
 * revoked/errored channels, and crawl targets that are not verified or whose robots check never ran.
 * Evidence older than 72 h degrades a claim to plain price (fail closed); we only report what the API states.
 */
export function incidents(channels: readonly ChannelConnection[], targets: readonly CrawlTarget[]): readonly IncidentVM[] {
  const out: IncidentVM[] = [];
  for (const c of channels) {
    if (c.status === "revoked") out.push({ id: c.id, kind: "channel", subject: c.shop_domain, reasonKey: "channels.incident.revoked" });
    if (c.status === "error") out.push({ id: c.id, kind: "channel", subject: c.shop_domain, reasonKey: "channels.incident.error" });
  }
  for (const t of targets) {
    if (t.verified_at === null) out.push({ id: t.id, kind: "crawl", subject: t.domain, reasonKey: "channels.incident.unverified" });
    else if (t.robots_checked_at === null) out.push({ id: t.id, kind: "crawl", subject: t.domain, reasonKey: "channels.incident.robots" });
  }
  return out;
}

export const PARITY_FIX_WINDOW_MS = 48 * 3_600_000;
export const PARITY_REASON_CODE = "cross_channel_cheaper";

export interface ParityWarningVM {
  readonly id: string;
  readonly action: string;
  readonly appliedAt: string;
  /** Deadline = applied_at + 48 h (spec section 9.3). The countdown is driven by the SERVER clock, never the device clock. */
  readonly fixDeadlineIso: string;
  readonly cure: string | null;
}

export function parityWarnings(actions: PriceTrust["active_actions"], locale: Locale): readonly ParityWarningVM[] {
  return actions
    .filter((a) => a.reason_code === PARITY_REASON_CODE)
    .map((a) => ({
      id: a.id,
      action: a.action,
      appliedAt: formatDateTime(a.applied_at, locale),
      fixDeadlineIso: new Date(Date.parse(a.applied_at) + PARITY_FIX_WINDOW_MS).toISOString(),
      cure: a.cure === undefined ? null : locale === "ar" ? a.cure.ar : (a.cure.en ?? a.cure.ar),
    }));
}
