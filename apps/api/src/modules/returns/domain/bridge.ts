/**
 * Single seam to the pure returns domain. Imported through the public @outlet/domain entry
 * (namespace `returns`), re-exported flat so the module code is unchanged. Only this file does that.
 */
import { returns } from "@outlet/domain";

export const INELIGIBLE_CODES = returns.INELIGIBLE_CODES;
export const InvalidReturnAllocationError = returns.InvalidReturnAllocationError;
export const InvalidReturnInputError = returns.InvalidReturnInputError;
export const MS_PER_DAY = returns.MS_PER_DAY;
export const MS_PER_HOUR = returns.MS_PER_HOUR;
export const REFUND_PREFERENCES = returns.REFUND_PREFERENCES;
export const REJECTION_REASONS = returns.REJECTION_REASONS;
export const RETURN_CLASSES = returns.RETURN_CLASSES;
export const RETURN_METHODS = returns.RETURN_METHODS;
export const RETURN_POLICY = returns.RETURN_POLICY;
export const RETURN_REASONS = returns.RETURN_REASONS;
export const RETURN_RESOLUTIONS = returns.RETURN_RESOLUTIONS;
export const SERIAL_RETURNER_POLICY = returns.SERIAL_RETURNER_POLICY;
export const SHIPPING_PAYERS = returns.SHIPPING_PAYERS;
export const WINDOW_CLASSES = returns.WINDOW_CLASSES;
export const addBusinessDays = returns.addBusinessDays;
export const allocateRefund = returns.allocateRefund;
export const cumulativeShare = returns.cumulativeShare;
export const disputeWindowEndsAtMs = returns.disputeWindowEndsAtMs;
export const evaluateReturnRequest = returns.evaluateReturnRequest;
export const evaluateReturnerStanding = returns.evaluateReturnerStanding;
export const ineligibleReason = returns.ineligibleReason;
export const inspectionDueAtMs = returns.inspectionDueAtMs;
export const isInspectionOverdue = returns.isInspectionOverdue;
export const isNoFaultOfShopper = returns.isNoFaultOfShopper;
export const isSellerFault = returns.isSellerFault;
export const shippingPayerFor = returns.shippingPayerFor;
export const windowClassOf = returns.windowClassOf;
export const windowDays = returns.windowDays;
export const windowEndsAtMs = returns.windowEndsAtMs;
export type IneligibleCode = returns.IneligibleCode;
export type LineAllocationInput = returns.LineAllocationInput;
export type LineRefundAllocation = returns.LineRefundAllocation;
export type LocalizedReason = returns.LocalizedReason;
export type RefundAllocation = returns.RefundAllocation;
export type RefundPreference = returns.RefundPreference;
export type RejectionReason = returns.RejectionReason;
export type ReturnClass = returns.ReturnClass;
export type ReturnEligibility = returns.ReturnEligibility;
export type ReturnMethod = returns.ReturnMethod;
export type ReturnReason = returns.ReturnReason;
export type ReturnRequestFacts = returns.ReturnRequestFacts;
export type ReturnResolution = returns.ReturnResolution;
export type ReturnerHistory = returns.ReturnerHistory;
export type ReturnerStanding = returns.ReturnerStanding;
export type ShippingPayer = returns.ShippingPayer;
export type WindowClass = returns.WindowClass;

export {
  GuardRejectedError,
  InvalidTransitionError,
  RETURN_STATES,
  divideRoundHalfEven,
  money,
  returnMachine,
  type Money,
  type ReturnEvent as ReturnMachineEvent,
  type ReturnState,
} from "@outlet/domain";
