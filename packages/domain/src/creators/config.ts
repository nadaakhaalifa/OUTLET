/**
 * Creators and affiliates (spec P3-04, ADR-0037). Pure domain: no I/O, no clock, no randomness.
 * Money is integer piastres. Rates, caps and thresholds are owner decisions (ADR-0037 "Owner
 * decision required"); the defaults below are PLACEHOLDERS that keep accruals small and payouts off.
 */
import { CreatorConfigError } from "./errors";

export interface CreatorConfig {
  /** Last-click attribution window (spec: 7 days, configurable). */
  readonly attributionWindowMs: number;
  /** Commission rate when a category has no rate of its own, basis points. */
  readonly defaultRateBps: bigint;
  /** Per-category overrides, admin-editable, versioned by the caller (snapshotted on attribution). */
  readonly categoryRateBps: Readonly<Record<string, bigint>>;
  /** Max commission that may ACCRUE per creator per Cairo month, piastres (fraud guard). */
  readonly monthlyAccrualCap: bigint;
  /** Clicks per IP hash per creator per hour that still count. */
  readonly maxCountedClicksPerIpPerHour: number;
  /** Clicks per device hash per creator per hour that still count (A-1: keyed on the identifier actually used). */
  readonly maxCountedClicksPerDevicePerHour: number;
  /** Clicks per link per hour that still count (flood guard for one link). */
  readonly maxCountedClicksPerLinkPerHour: number;
  /** Same device on the same link inside this window stores nothing new (dedupe). */
  readonly clickDedupeWindowMs: number;
  /** After a first-party session start, later clicks for another creator cannot displace an earlier valid click for this long. */
  readonly protectedWindowMs: number;
  /** A link component strictly larger than this voids the commission silently. */
  readonly clusterThreshold: number;
  readonly minAgeYears: number;
  /** Smallest payout batch line, piastres. */
  readonly minPayout: bigint;
  /** Handles that nobody may register (brand and platform names, impersonation guard). */
  readonly reservedHandles: readonly string[];
  /** Platform VAT rate used to take VAT out of the commission base, basis points. */
  readonly vatBps: bigint;
}

export const DEFAULT_CREATOR_CONFIG: CreatorConfig = {
  attributionWindowMs: 7 * 86_400_000,
  defaultRateBps: 300n,
  categoryRateBps: {},
  monthlyAccrualCap: 2_000_000n,
  maxCountedClicksPerIpPerHour: 30,
  maxCountedClicksPerDevicePerHour: 20,
  maxCountedClicksPerLinkPerHour: 500,
  clickDedupeWindowMs: 60_000,
  protectedWindowMs: 24 * 3_600_000,
  clusterThreshold: 3,
  minAgeYears: 21,
  minPayout: 50_000n,
  reservedHandles: ["outlet", "z-outlet", "zoutlet", "haul", "admin", "support", "official", "staff"],
  vatBps: 1_400n,
};

export function validateCreatorConfig(c: CreatorConfig): CreatorConfig {
  const bad = (m: string): never => {
    throw new CreatorConfigError(m);
  };
  if (!(c.attributionWindowMs > 0)) bad("attributionWindowMs must be positive");
  if (c.defaultRateBps < 0n || c.defaultRateBps > 5_000n) bad("defaultRateBps must be 0..5000");
  for (const [k, v] of Object.entries(c.categoryRateBps)) {
    if (v < 0n || v > 5_000n) bad(`category rate for ${k} must be 0..5000`);
  }
  if (c.monthlyAccrualCap < 0n) bad("monthlyAccrualCap must not be negative");
  if (!Number.isInteger(c.maxCountedClicksPerIpPerHour) || c.maxCountedClicksPerIpPerHour < 1) {
    bad("maxCountedClicksPerIpPerHour must be a positive integer");
  }
  for (const [k, v] of [
    ["maxCountedClicksPerDevicePerHour", c.maxCountedClicksPerDevicePerHour],
    ["maxCountedClicksPerLinkPerHour", c.maxCountedClicksPerLinkPerHour],
  ] as const) {
    if (!Number.isInteger(v) || v < 1) bad(`${k} must be a positive integer`);
  }
  if (!(c.clickDedupeWindowMs >= 0)) bad("clickDedupeWindowMs must not be negative");
  if (!(c.protectedWindowMs >= 0)) bad("protectedWindowMs must not be negative");
  if (!Number.isInteger(c.clusterThreshold) || c.clusterThreshold < 1) bad("clusterThreshold must be >= 1");
  if (c.minAgeYears < 21) bad("creators must be 21+ (spec B6, ADR-0037)");
  if (c.minPayout < 0n) bad("minPayout must not be negative");
  if (c.vatBps < 0n || c.vatBps > 100_000n) bad("vatBps out of range");
  return c;
}

/** Rate snapshot for a category. */
export function rateFor(cfg: CreatorConfig, categoryId: string | null): bigint {
  if (categoryId === null) return cfg.defaultRateBps;
  return cfg.categoryRateBps[categoryId] ?? cfg.defaultRateBps;
}
