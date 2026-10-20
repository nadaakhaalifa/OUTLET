/** Single seam to the pure creators domain (@outlet/domain namespace `creators`). Aliases only. */
import { admin, creators, payouts, rewards } from "@outlet/domain";
export {
  chart,
  creatorCommissionAccrued,
  creatorCommissionClawedBack,
  creatorPayout,
  money,
  reverseEntry,
  type EntryMeta,
  type JournalEntry,
} from "@outlet/domain";
export type ApprovalRecord = admin.ApprovalRecord;
export type ApprovalConfig = admin.ApprovalConfig;
export import DEFAULT_APPROVAL_CONFIG = admin.DEFAULT_APPROVAL_CONFIG;
export import payoutApprovalStatus = payouts.payoutApprovalStatus;
export import approvalRequirementMet = payouts.approvalRequirementMet;
export import ledgerPayoutRef = payouts.ledgerPayoutRef;
export import eventForOutcome = payouts.eventForOutcome;

export type ClickFact = creators.ClickFact;
export type CommissionState = creators.CommissionState;
export type CreatorConfig = creators.CreatorConfig;
export type CreatorFraudReason = creators.CreatorFraudReason;
export type CreatorKycState = creators.CreatorKycState;
export type CreatorStatus = creators.CreatorStatus;
export type IneligibleReason = creators.IneligibleReason;
export type LinkTargetType = creators.LinkTargetType;
export type PartyIdentifiers = creators.PartyIdentifiers;
export type PayoutPref = creators.PayoutPref;
export type RefundPlan = creators.RefundPlan;
export type UaClass = creators.UaClass;
export type PayoutState = payouts.PayoutState;
export type PayoutEvent = payouts.PayoutEvent;
export type PayoutContext = payouts.PayoutContext;

export import COMMISSION_STATES = creators.COMMISSION_STATES;
export import CREATOR_STATUSES = creators.CREATOR_STATUSES;
export import DEFAULT_CREATOR_CONFIG = creators.DEFAULT_CREATOR_CONFIG;
export import KYC_STATES = creators.KYC_STATES;
export import LINK_TARGET_TYPES = creators.LINK_TARGET_TYPES;
export import PAYOUT_PREFS = creators.PAYOUT_PREFS;
export import UA_CLASSES = creators.UA_CLASSES;
export import applyCreatorPayoutEvent = creators.applyCreatorPayoutEvent;
export import accrualGate = creators.accrualGate;
export import applyMonthlyCap = creators.applyMonthlyCap;
export import attributionWindowEnd = creators.attributionWindowEnd;
export import balanceView = creators.balanceView;
export import canEarn = creators.canEarn;
export import checkApplication = creators.checkApplication;
export import classifyClick = creators.classifyClick;
export import commissionOn = creators.commissionOn;
export import creatorPayoutApproval = creators.creatorPayoutApproval;
export import decideCreatorFraud = creators.decideCreatorFraud;
export import eligibleBase = creators.eligibleBase;
export import normalizeHandle = creators.normalizeHandle;
export import payoutEligible = creators.payoutEligible;
export import payoutLineAmount = creators.payoutLineAmount;
export import planRefund = creators.planRefund;
export import planVoid = creators.planVoid;
export import rateFor = creators.rateFor;
export import refundedBaseOf = creators.refundedBaseOf;
export import selectLastClick = creators.selectLastClick;
export import transitionCommission = creators.transitionCommission;
export import validateCreatorConfig = creators.validateCreatorConfig;
export import isReservedHandle = creators.isReservedHandle;
export import cairoMonthKey = rewards.cairoMonthKey;
export import commissionTargetOf = creators.targetCommission;
export import rateTable = creators.rateFor;
export type BalanceViewT = ReturnType<typeof creators.balanceView>;
