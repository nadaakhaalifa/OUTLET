import type { PlusPlanWire } from "../api/schemas";
import { parseMinor } from "../lib/format";

export const MEMBER_NOTICE_DAYS = 30;
const DAY_MS = 86_400_000;

export interface PlanVersionRow {
  readonly id: string;
  readonly code: string;
  readonly interval: "month" | "year";
  readonly priceMinor: bigint;
  readonly trialDays: number;
  readonly version: number;
  readonly active: boolean;
  readonly effectiveFromMs: number;
  readonly membersNotifiedAtMs: number | null;
  /** Price takes effect in the future (members were or must be told). */
  readonly scheduled: boolean;
}
export interface PlanGroup { readonly code: string; readonly versions: readonly PlanVersionRow[] }

export function planGroups(items: readonly PlusPlanWire[], serverNowMs: number): readonly PlanGroup[] {
  const rows: PlanVersionRow[] = items.map((p) => ({
    id: p.id, code: p.code, interval: p.interval, priceMinor: parseMinor(p.price.amount_minor) ?? 0n, trialDays: p.trial_days,
    version: p.version, active: p.active, effectiveFromMs: Date.parse(p.effective_from),
    membersNotifiedAtMs: p.members_notified_at === null ? null : Date.parse(p.members_notified_at),
    scheduled: Date.parse(p.effective_from) > serverNowMs,
  }));
  const codes = [...new Set(rows.map((r) => r.code))].sort();
  return codes.map((code) => ({ code, versions: rows.filter((r) => r.code === code).sort((a, b) => b.version - a.version) }));
}

export type PlusFormError = "code" | "price" | "trial" | "date" | "notice" | "approval";
export interface PlusForm {
  readonly code: string; readonly interval: string; readonly priceEgp: string; readonly trialDays: string;
  readonly effectiveFrom: string; readonly approvalId?: string;
}
export type PlusFormResult =
  | { readonly ok: true; readonly value: { code: string; interval: "month" | "year"; price_minor: string; trial_days: number; effective_from: string } }
  | { readonly ok: false; readonly errors: readonly PlusFormError[] };

/** EGP text ("200" or "199.50") to piastres without floats. */
export function egpToMinor(text: string): bigint | null {
  const m = /^(\d{1,12})(?:[.,](\d{1,2}))?$/.exec(text.trim());
  if (m === null) return null;
  const whole = BigInt(m[1] ?? "0");
  const frac = BigInt((m[2] ?? "").padEnd(2, "0") || "0");
  const v = whole * 100n + frac;
  return v > 0n ? v : null;
}

/** Earliest effective date that still gives members the 30-day notice (server clock). */
export const earliestEffectiveMs = (serverNowMs: number): number => serverNowMs + MEMBER_NOTICE_DAYS * DAY_MS;

export function validatePlusForm(f: PlusForm, serverNowMs: number): PlusFormResult {
  const errors: PlusFormError[] = [];
  if (!/^plus_[a-z0-9_]{1,40}$/.test(f.code)) errors.push("code");
  const price = egpToMinor(f.priceEgp);
  if (price === null) errors.push("price");
  const trial = /^\d{1,2}$/.test(f.trialDays) ? Number(f.trialDays) : f.trialDays === "" ? 0 : -1;
  if (trial < 0 || trial > 60) errors.push("trial");
  const eff = Date.parse(f.effectiveFrom);
  if (Number.isNaN(eff)) errors.push("date");
  else if (eff < earliestEffectiveMs(serverNowMs)) errors.push("notice");
  const interval = f.interval === "month" || f.interval === "year" ? f.interval : null;
  if (interval === null) errors.push("code");
  if (errors.length > 0 || price === null || interval === null) return { ok: false, errors };
  return { ok: true, value: { code: f.code, interval, price_minor: price.toString(), trial_days: trial, effective_from: new Date(eff).toISOString() } };
}

/** Plan metrics (pause/cancel/churn) have no admin read endpoint: never invent them. */
export const PLUS_METRICS_NOT_MEASURED = ["paused", "cancelled_at_period_end", "monthly_churn", "trial_to_paid"] as const;
