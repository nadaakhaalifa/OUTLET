import { z } from 'zod';
import { ConsentError } from './errors.js';
import { type Clock, toIso } from './ports.js';

/** The nine purposes of spec B1. */
export const CONSENT_PURPOSES = [
  'marketing_push',
  'marketing_whatsapp',
  'marketing_email',
  'analytics',
  'personalization',
  'budget_insights',
  'measurements',
  'location_precise',
  'cross_border_ml',
] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];

/**
 * How the decision was captured. There is deliberately no "default" or
 * "pre_ticked" method: consent is only ever the result of an explicit action.
 */
export const CONSENT_METHODS = [
  'onboarding_toggle',
  'settings_toggle',
  'permission_dialog',
  'web_banner',
  'support_agent_on_request',
] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

export const ConsentRecordSchema = z
  .object({
    userId: z.string().min(1),
    purpose: z.enum(CONSENT_PURPOSES),
    /** Version of the consent text the user saw. */
    version: z.number().int().positive(),
    granted: z.boolean(),
    method: z.enum(CONSENT_METHODS),
    at: z.iso.datetime(),
    ipHash: z.string().regex(/^[0-9a-f]{16,128}$/),
  })
  .strict();
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

/** Append-only history. Latest record per purpose wins. */
export type ConsentHistory = readonly ConsentRecord[];

export interface ConsentInput {
  readonly userId: string;
  readonly purpose: ConsentPurpose;
  readonly version: number;
  readonly method: ConsentMethod;
  readonly ipHash: string;
}

function build(input: ConsentInput, granted: boolean, clock: Clock): ConsentRecord {
  const parsed = ConsentRecordSchema.safeParse({
    ...input,
    granted,
    at: toIso(clock.now()),
  });
  if (!parsed.success) throw new ConsentError(`Invalid consent record: ${parsed.error.message}`);
  return parsed.data;
}

/** Returns a new history with an explicit grant appended. */
export function grantConsent(history: ConsentHistory, input: ConsentInput, clock: Clock): ConsentHistory {
  return [...history, build(input, true, clock)];
}

/** Withdrawal is always allowed, at any version, even if never granted. */
export function withdrawConsent(history: ConsentHistory, input: ConsentInput, clock: Clock): ConsentHistory {
  return [...history, build(input, false, clock)];
}

function latest(history: ConsentHistory, userId: string, purpose: ConsentPurpose): ConsentRecord | undefined {
  let best: ConsentRecord | undefined;
  for (const r of history) {
    if (r.userId !== userId || r.purpose !== purpose) continue;
    // `>=` so that, at equal timestamps, the later-appended record wins.
    if (best === undefined || Date.parse(r.at) >= Date.parse(best.at)) best = r;
  }
  return best;
}

export type ConsentStatus = 'never_asked' | 'granted' | 'withdrawn' | 'reconsent_required';

export function consentStatus(
  history: ConsentHistory,
  userId: string,
  purpose: ConsentPurpose,
  currentVersion: number,
): ConsentStatus {
  const r = latest(history, userId, purpose);
  if (r === undefined) return 'never_asked';
  if (!r.granted) return 'withdrawn';
  return r.version >= currentVersion ? 'granted' : 'reconsent_required';
}

/** Never pre-ticked: every purpose starts unticked. */
export function defaultConsentView(): Readonly<Record<ConsentPurpose, false>> {
  return Object.fromEntries(CONSENT_PURPOSES.map((p) => [p, false])) as Record<ConsentPurpose, false>;
}

/** Current effective consent for the Settings -> Privacy screen. */
export function consentView(
  history: ConsentHistory,
  userId: string,
  currentVersions: Readonly<Record<ConsentPurpose, number>>,
): Readonly<Record<ConsentPurpose, boolean>> {
  return Object.fromEntries(
    CONSENT_PURPOSES.map((p) => [p, consentStatus(history, userId, p, currentVersions[p]) === 'granted']),
  ) as Record<ConsentPurpose, boolean>;
}

/** SDKs and processing activities that may only start after consent. */
export const GATED_PROCESSING = [
  'posthog',
  'sentry_breadcrumbs',
  'ads_sdk',
  'push_marketing',
  'whatsapp_marketing',
  'email_marketing',
  'personalization_engine',
  'budget_insights',
  'measurement_profile',
  'precise_location',
  'external_ml_api',
] as const;
export type GatedProcessing = (typeof GATED_PROCESSING)[number];

/**
 * Required purposes per gated item. All listed purposes must be granted.
 * Mapping of ads_sdk and sentry_breadcrumbs is an owner decision (see report).
 */
export const PROCESSING_REQUIREMENTS: Readonly<Record<GatedProcessing, readonly ConsentPurpose[]>> = {
  posthog: ['analytics'],
  sentry_breadcrumbs: ['analytics'],
  ads_sdk: ['analytics', 'personalization'],
  push_marketing: ['marketing_push'],
  whatsapp_marketing: ['marketing_whatsapp'],
  email_marketing: ['marketing_email'],
  personalization_engine: ['personalization'],
  budget_insights: ['budget_insights'],
  measurement_profile: ['measurements'],
  precise_location: ['location_precise'],
  external_ml_api: ['cross_border_ml'],
};

export type InitDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly missing: readonly { readonly purpose: ConsentPurpose; readonly status: ConsentStatus }[];
    };

/** May this SDK / processing initialise for this user right now? Fail closed. */
export function mayInitialise(
  item: GatedProcessing,
  history: ConsentHistory,
  userId: string,
  currentVersions: Readonly<Record<ConsentPurpose, number>>,
): InitDecision {
  const missing = PROCESSING_REQUIREMENTS[item].flatMap((purpose) => {
    const status = consentStatus(history, userId, purpose, currentVersions[purpose]);
    return status === 'granted' ? [] : [{ purpose, status }];
  });
  return missing.length === 0 ? { allowed: true } : { allowed: false, missing };
}
