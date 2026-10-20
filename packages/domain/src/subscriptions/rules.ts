import {
  APP_FEATURE_KEYS,
  COMMERCE_BENEFIT_KEYS,
  DAY_MS,
  PAUSE_MONTHS_MAX,
  PAUSE_MONTHS_MIN,
  PRICE_NOTICE_DAYS,
  type EntitlementGrant,
  type PlusInterval,
  type PlusPlan,
  type PlusSubscription,
} from "./types";

/**
 * The instant until which a subscription entitles its owner, or null when it never does.
 * TRIALING until trial end; ACTIVE and CANCELLED_AT_PERIOD_END until period end exactly;
 * PAST_DUE until the grace end (benefits continue through dunning); PAUSED and EXPIRED never.
 */
export function entitlementEndsAt(sub: PlusSubscription): number | null {
  switch (sub.status) {
    case "TRIALING":
      return sub.trialEndMs ?? sub.periodEndMs;
    case "ACTIVE":
    case "CANCELLED_AT_PERIOD_END":
      return sub.periodEndMs;
    case "PAST_DUE":
      return sub.graceEndsAtMs;
    case "PAUSED":
    case "EXPIRED":
      return null;
  }
}

/** Half open: entitled strictly before the end instant, so benefits end exactly at period_end. */
export function isEntitled(sub: PlusSubscription, nowMs: number): boolean {
  const end = entitlementEndsAt(sub);
  return end !== null && nowMs < end;
}

/** Plan A: only commerce benefits. app_features is empty and Plus never gates the stylist. */
export function entitlementGrants(): readonly EntitlementGrant[] {
  return [
    ...COMMERCE_BENEFIT_KEYS.map((key): EntitlementGrant => ({ group: "commerce_benefits", key })),
    ...APP_FEATURE_KEYS.map((key: string): EntitlementGrant => ({ group: "app_features", key })),
  ];
}

// ---- trial: one per person (phone, device, card fingerprint) ---------------------------------

export interface TrialIdentity {
  readonly phoneHash: string | null;
  readonly deviceId: string | null;
  readonly cardFingerprint: string;
}

/** One key per identifier. Any already claimed key denies the trial ("same card, new phone: no trial"). */
export function trialKeys(id: TrialIdentity): readonly string[] {
  const keys = [`card:${id.cardFingerprint}`];
  if (id.phoneHash !== null) keys.push(`phone:${id.phoneHash}`);
  if (id.deviceId !== null) keys.push(`device:${id.deviceId}`);
  return keys;
}

export function trialDenied(keys: readonly string[], claimed: ReadonlySet<string>): boolean {
  return keys.some((k) => claimed.has(k));
}

// ---- age gate (ADR-0012) ---------------------------------------------------------------------

/** Unknown age fails closed. */
export function meetsMinAge(ageYears: number | null, minAge: number): boolean {
  return ageYears !== null && ageYears >= minAge;
}

// ---- plans and price changes -----------------------------------------------------------------

/** The plan version that bills a period starting at `atMs`: highest active version already effective. */
export function selectPlanVersion(versions: readonly PlusPlan[], atMs: number): PlusPlan | null {
  let best: PlusPlan | null = null;
  for (const p of versions) {
    if (!p.active || p.effectiveFromMs > atMs) continue;
    if (best === null || p.version > best.version) best = p;
  }
  return best;
}

/** A new price needs at least 30 days notice before it can bill any existing member. */
export function priceChangeNoticeOk(nowMs: number, effectiveFromMs: number): boolean {
  return effectiveFromMs - nowMs >= PRICE_NOTICE_DAYS * DAY_MS;
}

export function validPauseMonths(months: number): boolean {
  return Number.isInteger(months) && months >= PAUSE_MONTHS_MIN && months <= PAUSE_MONTHS_MAX;
}

export type SwitchKind = "same" | "upgrade_now" | "downgrade_at_period_end";

/** Monthly -> yearly is immediate with proration credit; yearly -> monthly waits for the period end. */
export function switchKind(from: PlusInterval, to: PlusInterval): SwitchKind {
  if (from === to) return "same";
  return from === "month" ? "upgrade_now" : "downgrade_at_period_end";
}
