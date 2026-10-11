/**
 * Single seam to the pure Plus domain. The package index (packages/domain/src/index.ts) exports the
 * `subscriptions` namespace; this file aliases it. Nothing else in the module imports the domain.
 */
import { subscriptions } from "@outlet/domain";
export import DAY_MS = subscriptions.DAY_MS;
export import PLUS_INTERVALS = subscriptions.PLUS_INTERVALS;
export type PlusInterval = subscriptions.PlusInterval;
export import COMMERCE_BENEFIT_KEYS = subscriptions.COMMERCE_BENEFIT_KEYS;
export type CommerceBenefitKey = subscriptions.CommerceBenefitKey;
export import APP_FEATURE_KEYS = subscriptions.APP_FEATURE_KEYS;
export import ENTITLEMENT_GROUPS = subscriptions.ENTITLEMENT_GROUPS;
export type EntitlementGroup = subscriptions.EntitlementGroup;
export type EntitlementGrant = subscriptions.EntitlementGrant;
export import DUNNING_RETRY_DAYS = subscriptions.DUNNING_RETRY_DAYS;
export import GRACE_DAYS = subscriptions.GRACE_DAYS;
export import REFUND_WINDOW_DAYS = subscriptions.REFUND_WINDOW_DAYS;
export import PRICE_NOTICE_DAYS = subscriptions.PRICE_NOTICE_DAYS;
export import TRIAL_REMINDER_DAYS = subscriptions.TRIAL_REMINDER_DAYS;
export import PAUSE_MONTHS_MIN = subscriptions.PAUSE_MONTHS_MIN;
export import PAUSE_MONTHS_MAX = subscriptions.PAUSE_MONTHS_MAX;
export import DEFAULT_PLUS_MIN_AGE = subscriptions.DEFAULT_PLUS_MIN_AGE;
export import PLUS_VAT_BPS = subscriptions.PLUS_VAT_BPS;
export type PlusPlan = subscriptions.PlusPlan;
export type PlusSubscription = subscriptions.PlusSubscription;
export import DEFAULT_PLAN_DEFINITIONS = subscriptions.DEFAULT_PLAN_DEFINITIONS;
export import SubscriptionRuleError = subscriptions.SubscriptionRuleError;
export import InvalidSubscriptionTransition = subscriptions.InvalidSubscriptionTransition;
export import addMonthsUtc = subscriptions.addMonthsUtc;
export import periodEndFor = subscriptions.periodEndFor;
export import prorationCredit = subscriptions.prorationCredit;
export import upgradeCharge = subscriptions.upgradeCharge;
export import yearlyMarketing = subscriptions.yearlyMarketing;
export import graceEndsAt = subscriptions.graceEndsAt;
export import dunningAttemptTimes = subscriptions.dunningAttemptTimes;
export import dunningAttemptKey = subscriptions.dunningAttemptKey;
export import nextDunningAction = subscriptions.nextDunningAction;
export import refundEligibility = subscriptions.refundEligibility;
export import recognitionDue = subscriptions.recognitionDue;
export type ProrationInput = subscriptions.ProrationInput;
export type ProrationResult = subscriptions.ProrationResult;
export type UpgradeCharge = subscriptions.UpgradeCharge;
export type YearlyMarketing = subscriptions.YearlyMarketing;
export type DunningAction = subscriptions.DunningAction;
export type RefundEligibility = subscriptions.RefundEligibility;
export import entitlementEndsAt = subscriptions.entitlementEndsAt;
export import isEntitled = subscriptions.isEntitled;
export import entitlementGrants = subscriptions.entitlementGrants;
export import trialKeys = subscriptions.trialKeys;
export import trialDenied = subscriptions.trialDenied;
export import meetsMinAge = subscriptions.meetsMinAge;
export import selectPlanVersion = subscriptions.selectPlanVersion;
export import priceChangeNoticeOk = subscriptions.priceChangeNoticeOk;
export import validPauseMonths = subscriptions.validPauseMonths;
export import switchKind = subscriptions.switchKind;
export type TrialIdentity = subscriptions.TrialIdentity;
export type SwitchKind = subscriptions.SwitchKind;
export import startTrial = subscriptions.startTrial;
export import startPaid = subscriptions.startPaid;
export import convertTrial = subscriptions.convertTrial;
export import expireUnpaidTrial = subscriptions.expireUnpaidTrial;
export import renewSucceeded = subscriptions.renewSucceeded;
export import renewFailed = subscriptions.renewFailed;
export import dunningFailed = subscriptions.dunningFailed;
export import dunningSucceeded = subscriptions.dunningSucceeded;
export import graceElapsed = subscriptions.graceElapsed;
export import periodEnded = subscriptions.periodEnded;
export import pause = subscriptions.pause;
export import resume = subscriptions.resume;
export import cancel = subscriptions.cancel;
export import reactivate = subscriptions.reactivate;
export import switchNow = subscriptions.switchNow;
export import scheduleSwitch = subscriptions.scheduleSwitch;
export import cancelWithRefund = subscriptions.cancelWithRefund;
export import trialReminderSent = subscriptions.trialReminderSent;
export type NewSubscription = subscriptions.NewSubscription;
export {
  chart,
  createJournalEntry,
  money,
  planPlusRecognition,
  plusCharged,
  plusRevenueRecognised,
  reverseEntry,
  subtract,
  vatIncluded,
  type EntryMeta,
  type JournalEntry,
  type Money,
} from "@outlet/domain";
export { SUBSCRIPTION_STATES, type SubscriptionState } from "@outlet/domain";
