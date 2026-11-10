import { vrpFromInternal } from "./vrp.js";
import { computeWindow, DAY_MS, WINDOW_MS } from "./window.js";
import type { PriceEventInput, PriceWindow } from "./window.js";

/** Match threshold tau in basis points (master prompt 9.2 starts at 0.92; tune on the labelled set, V13). */
export const TAU_BP = 9200;
/** External evidence older than this is stale: the claim fails closed to the plain price (spec section 4). */
export const STALE_EVIDENCE_MS = 72 * 3_600_000;

export interface ExternalSnapshot {
  readonly priceMinor: bigint;
  readonly fetchedAt: Date;
  readonly id?: string;
}

export interface ExternalWindow {
  readonly window: PriceWindow;
  readonly lastFetchedAt: Date | null;
}

/** The seller's own site as a price series (snapshots are the "price events" of the external channel). */
export const externalWindow = (snaps: readonly ExternalSnapshot[], now: Date): ExternalWindow => {
  const events: PriceEventInput[] = snaps.map((s) => (s.id === undefined ? { priceMinor: s.priceMinor, validFrom: s.fetchedAt } : { priceMinor: s.priceMinor, validFrom: s.fetchedAt, id: s.id }));
  const last = snaps.reduce<Date | null>((m, s) => (s.fetchedAt <= now && (m === null || s.fetchedAt > m) ? s.fetchedAt : m), null);
  return { window: computeWindow(events, now), lastFetchedAt: last };
};

export type VrpReason = "internal_only" | "external_lower" | "external_not_lower" | "no_internal_reference" | "unmatched" | "short_history" | "stale_external";
export interface VrpResult {
  readonly vrp: bigint | null;
  readonly referenceClass: "internal" | "external" | "none";
  readonly reason: VrpReason;
  /** Brand RRP is a separate evidence class, passed through and NEVER mixed into the VRP. */
  readonly brandRrp: bigint | null;
}
export interface VrpOptions {
  readonly now: Date;
  readonly brandRrp?: bigint | null;
}

/**
 * Strictest wins: VRP = min(internal reference, external 30-day low). External evidence can only LOWER the reference, never raise it
 * and never create one (no internal reference stays null: a seller cannot get a % from the external channel alone). Documented choice.
 * Fail closed: a matched channel whose last fetch is older than 72 h removes the claim (null); a match below tau, or an external
 * history under 30 days, is ignored (internal only).
 */
export const vrpWithExternal = (internal: PriceWindow, external: ExternalWindow | null, matchConfBp: number, tauBp: number, opts: VrpOptions): VrpResult => {
  const brandRrp = opts.brandRrp ?? null;
  const base = vrpFromInternal(internal, opts.now);
  const out = (vrp: bigint | null, referenceClass: VrpResult["referenceClass"], reason: VrpReason): VrpResult => ({ vrp, referenceClass, reason, brandRrp });
  if (base === null) return out(null, "none", "no_internal_reference");
  if (external === null || matchConfBp < tauBp) return out(base, "internal", "unmatched");
  if (external.lastFetchedAt === null || opts.now.getTime() - external.lastFetchedAt.getTime() > STALE_EVIDENCE_MS) return out(null, "none", "stale_external");
  const w = external.window;
  if (w.firstSeenAt === null || w.low30d === null || opts.now.getTime() - w.firstSeenAt.getTime() < WINDOW_MS) return out(base, "internal", "short_history");
  return w.low30d < base ? out(w.low30d, "external", "external_lower") : out(base, "internal", "external_not_lower");
};

export const hoursToMs = (h: number): number => h * 3_600_000;
export { DAY_MS };
