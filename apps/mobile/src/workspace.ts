/**
 * Single seam for workspace packages that are not yet declared as dependencies of @outlet/mobile
 * (apps/mobile/package.json is not owned by this task; see the report's needsDeps).
 * When the dependencies are added, replace these relative paths with the package names. No other
 * file in the app may import the packages directly.
 */
export {
  CONSENT_PURPOSES,
  consentStatus,
  consentView,
  defaultConsentView,
  evaluateCapability,
  evaluateDeletionEligibility,
  evaluateOnboardingAge,
  grantConsent,
  isDeviceBlocked,
  mayInitialise,
  parseCivilDate,
  withdrawConsent,
  ConsentRecordSchema,
  SoftBlockSchema,
  DEFAULT_COOLING_DAYS,
  UNDER_18_BLOCK_DAYS,
  EXPORT_TARGET_HOURS,
  DEFAULT_DSAR_SLA_DAYS,
} from "../../../packages/privacy/src/index";
export type {
  CivilDate,
  Clock as PrivacyClock,
  ConsentHistory,
  ConsentPurpose,
  ConsentRecord,
  ConsentMethod,
  ConsentStatus,
  DeletionBlocker,
  DeletionEligibility,
  DeletionSnapshot,
  DeviceSoftBlock,
  GatedProcessing,
  OnboardingAgeResult,
} from "../../../packages/privacy/src/index";

export { OTP_POLICY, isCountryAllowed, parseE164, resendDelayMs, sha256Hex } from "../../../packages/auth-core/src/index";

export {
  ConsentGatedTracker,
  RotatingPseudonymousId,
  createRecordingTransport,
} from "../../../packages/analytics/src/index";
export type {
  AnalyticsEventInput,
  AnalyticsEventName,
  ConsentChecker,
  IdGenerator,
  PseudonymState,
  PseudonymStore,
  Transport,
} from "../../../packages/analytics/src/index";
