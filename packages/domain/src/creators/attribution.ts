import type { CreatorConfig } from "./config";

export const UA_CLASSES = ["app", "browser", "bot", "headless"] as const;
export type UaClass = (typeof UA_CLASSES)[number];

export interface ClickFact {
  readonly id: string;
  readonly linkId: string;
  readonly creatorId: string;
  readonly atMs: number;
  /** SHA-256 hex. Never a raw identifier. */
  readonly deviceHash: string;
  /** False when the per-IP hourly cap already counted enough clicks. */
  readonly counted: boolean;
  readonly uaClass: UaClass;
}

/** Bots and headless agents never attribute (spec edge cases). */
export const isHumanClass = (u: UaClass): boolean => u === "app" || u === "browser";

/**
 * Click ingest decision: whether this click counts toward the per-IP hourly cap, and whether it can
 * ever attribute. Lossy-tolerant: an uncounted click is still stored for analytics.
 */
export function classifyClick(
  cfg: CreatorConfig,
  input: {
    readonly uaClass: UaClass;
    readonly countedForIpThisHour: number;
    readonly countedForDeviceThisHour?: number;
    readonly countedForLinkThisHour?: number;
  },
): { readonly counted: boolean; readonly attributable: boolean } {
  const underCap =
    input.countedForIpThisHour < cfg.maxCountedClicksPerIpPerHour &&
    (input.countedForDeviceThisHour ?? 0) < cfg.maxCountedClicksPerDevicePerHour &&
    (input.countedForLinkThisHour ?? 0) < cfg.maxCountedClicksPerLinkPerHour;
  const human = isHumanClass(input.uaClass);
  return { counted: underCap, attributable: underCap && human };
}

/** Deterministic order: latest first, ties by id descending. */
const newestFirst = (a: ClickFact, b: ClickFact): number => (a.atMs !== b.atMs ? b.atMs - a.atMs : a.id < b.id ? 1 : -1);

/**
 * Last valid click wins. A click is valid when: counted, human, from one of the buyer's devices,
 * not after the order, and within the window before it.
 */
export function selectLastClick(
  cfg: CreatorConfig,
  input: {
    readonly orderAtMs: number;
    readonly buyerDeviceHashes: readonly string[];
    readonly clicks: readonly ClickFact[];
    readonly activeCreatorIds?: ReadonlySet<string>;
    /**
     * Start of the buyer's most recent first-party session (server-side, from the identity port), or
     * null. A valid click from another creator that lands inside (start, start + protectedWindowMs]
     * cannot displace the latest valid click made before that start (A-1 hijack guard).
     */
    readonly sessionStartedAtMs?: number | null;
  },
): ClickFact | null {
  const devices = new Set(input.buyerDeviceHashes);
  const valid = input.clicks.filter(
    (c) =>
      c.counted &&
      isHumanClass(c.uaClass) &&
      devices.has(c.deviceHash) &&
      c.atMs <= input.orderAtMs &&
      input.orderAtMs - c.atMs <= cfg.attributionWindowMs &&
      (input.activeCreatorIds === undefined || input.activeCreatorIds.has(c.creatorId)),
  );
  const sorted = [...valid].sort(newestFirst);
  const s = input.sessionStartedAtMs ?? null;
  if (s !== null) {
    const anchor = sorted.find((c) => c.atMs <= s);
    if (anchor !== undefined) {
      const protectedUntil = s + cfg.protectedWindowMs;
      const open = sorted.filter((c) => !(c.atMs > s && c.atMs <= protectedUntil && c.creatorId !== anchor.creatorId));
      return open[0] ?? null;
    }
  }
  return sorted[0] ?? null;
}

export const attributionWindowEnd = (cfg: CreatorConfig, clickAtMs: number): number => clickAtMs + cfg.attributionWindowMs;
