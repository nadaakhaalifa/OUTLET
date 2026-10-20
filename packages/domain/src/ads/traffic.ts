import type { AdsConfig } from "./types";

/**
 * Invalid-traffic filter (spec 10 Security and abuse: click fraud, self-click, token replay).
 * Pure: the caller gathers the counters. A click that fails any check is stored, never billed, and
 * does not consume budget. Replay of a token is the store's UNIQUE(token_jti), reported as
 * `duplicate`, not here.
 */
export type InvalidReason =
  | "token_expired"
  | "too_fast"
  | "duplicate_window"
  | "burst"
  | "self_click"
  | "bot"
  | "campaign_drain"
  | "budget_exhausted"
  | "no_balance"
  | "kill_switch";

export interface ClickSignals {
  readonly nowMs: number;
  readonly tokenIssuedAtMs: number;
  readonly impressionAtMs: number;
  /** Valid clicks by this session on this campaign+product inside the dedupe window. */
  readonly validInWindow: number;
  /** Clicks (any outcome) by this session in the last minute. */
  readonly clicksLastMinute: number;
  /** Valid clicks by this session on this campaign since the Cairo day began. */
  readonly campaignClicksToday: number;
  /** Clicker belongs to the advertiser's own store. */
  readonly selfClick: boolean;
  /** 0..10_000, null when no signal is available (then it does not block). */
  readonly botScoreBp: number | null;
}

export type ClickVerdict = { readonly valid: true } | { readonly valid: false; readonly reason: InvalidReason };

export function classifyClick(s: ClickSignals, cfg: AdsConfig): ClickVerdict {
  if (s.nowMs - s.tokenIssuedAtMs > cfg.clickTokenTtlMs || s.nowMs < s.tokenIssuedAtMs) {
    return { valid: false, reason: "token_expired" };
  }
  if (s.selfClick) return { valid: false, reason: "self_click" };
  if (s.botScoreBp !== null && s.botScoreBp >= cfg.botScoreBlockBps) return { valid: false, reason: "bot" };
  if (s.nowMs - s.impressionAtMs < cfg.minDwellMs) return { valid: false, reason: "too_fast" };
  if (s.clicksLastMinute >= cfg.maxClicksPerSessionPerMinute) return { valid: false, reason: "burst" };
  if (s.validInWindow > 0) return { valid: false, reason: "duplicate_window" };
  if (s.campaignClicksToday >= cfg.maxClicksPerCampaignPerSessionDay) return { valid: false, reason: "campaign_drain" };
  return { valid: true };
}
