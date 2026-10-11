/** Single seam to the pure domain: the `payouts`, `admin` and `ledgerPosting` namespaces of @outlet/domain. Aliases only. */
export {
  PAYOUT_STATES,
  payoutMachine,
  money,
  type Money,
  type JournalEntry,
  type PayoutState,
  type PayoutEvent,
  type PayoutContext,
} from "@outlet/domain";
import { admin, ledgerPosting } from "@outlet/domain";
export { admin };
export type ApprovalRecord = admin.ApprovalRecord;
export type ApprovalConfig = admin.ApprovalConfig;
export import DEFAULT_APPROVAL_CONFIG = admin.DEFAULT_APPROVAL_CONFIG;
export import buildEntry = ledgerPosting.buildEntry;
export import buildReversal = ledgerPosting.buildReversal;
export import keyOf = ledgerPosting.keyOf;
export type PostingCommand = ledgerPosting.PostingCommand;
import { payouts } from "@outlet/domain";
export import InvalidPayoutInputError = payouts.InvalidPayoutInputError;
export import InvalidIbanError = payouts.InvalidIbanError;
export import cairoLocal = payouts.cairoLocal;
export import cairoToUtc = payouts.cairoToUtc;
export import cairoDateKey = payouts.cairoDateKey;
export import addCivilDays = payouts.addCivilDays;
export import requireInt = payouts.requireInt;
export import MS_PER_HOUR = payouts.MS_PER_HOUR;
export import MS_PER_DAY = payouts.MS_PER_DAY;
export type CairoLocal = payouts.CairoLocal;
export import latestCycle = payouts.latestCycle;
export import nextCycleRun = payouts.nextCycleRun;
export type CycleConfig = payouts.CycleConfig;
export import DEFAULT_CYCLE_CONFIG = payouts.DEFAULT_CYCLE_CONFIG;
export type PayoutCycle = payouts.PayoutCycle;
export import ineligibleReason = payouts.ineligibleReason;
export import planPayout = payouts.planPayout;
export import PAYOUT_HOLD_AFTER_CLOSE_MS = payouts.PAYOUT_HOLD_AFTER_CLOSE_MS;
export import DEFAULT_MINIMUM_PAYOUT_MINOR = payouts.DEFAULT_MINIMUM_PAYOUT_MINOR;
export type PayableItem = payouts.PayableItem;
export import CLAWBACK_KINDS = payouts.CLAWBACK_KINDS;
export type ClawbackKind = payouts.ClawbackKind;
export type Clawback = payouts.Clawback;
export type IneligibleReason = payouts.IneligibleReason;
export type PayoutPlanInput = payouts.PayoutPlanInput;
export type AppliedClawback = payouts.AppliedClawback;
export type PlanSkipReason = payouts.PlanSkipReason;
export type PayoutPlan = payouts.PayoutPlan;
export import normalizeIban = payouts.normalizeIban;
export import isValidEgyptIban = payouts.isValidEgyptIban;
export import assertEgyptIban = payouts.assertEgyptIban;
export import ibanLast4 = payouts.ibanLast4;
export import normalizeLegalName = payouts.normalizeLegalName;
export import namesMatch = payouts.namesMatch;
export type NameMatch = payouts.NameMatch;
export import payoutApprovalStatus = payouts.payoutApprovalStatus;
export type PayoutApprovalStatus = payouts.PayoutApprovalStatus;
export import PAYOUT_APPROVAL_SUBJECT_TYPE = payouts.PAYOUT_APPROVAL_SUBJECT_TYPE;
export import approvalRequirementMet = payouts.approvalRequirementMet;
export import buildStatement = payouts.buildStatement;
export type StatementFact = payouts.StatementFact;
export type StatementLineType = payouts.StatementLineType;
export type StatementLine = payouts.StatementLine;
export type StatementTotals = payouts.StatementTotals;
export type Statement = payouts.Statement;
export import applyPayoutEvent = payouts.applyPayoutEvent;
export import eventForOutcome = payouts.eventForOutcome;
export import HOLD_REASONS = payouts.HOLD_REASONS;
export type HoldReason = payouts.HoldReason;
export import LINE_HOLDING_STATES = payouts.LINE_HOLDING_STATES;
export import releasesLines = payouts.releasesLines;
export import canPayoutEvent = payouts.canPayoutEvent;
export import ledgerPayoutRef = payouts.ledgerPayoutRef;
export type ProviderOutcomeKind = payouts.ProviderOutcomeKind;
