/** Single seam to the pure domain: the `ledgerPosting` namespace of @outlet/domain plus the shared chart and ledger types. Aliases only; no behaviour. */
import { ledgerPosting } from "@outlet/domain";
export import PostingConflictError = ledgerPosting.PostingConflictError;
export import GiftCardSalesDisabledError = ledgerPosting.GiftCardSalesDisabledError;
export import InvalidReversalError = ledgerPosting.InvalidReversalError;
export import InvalidPostingCommandError = ledgerPosting.InvalidPostingCommandError;
export import RefundExceedsOriginalError = ledgerPosting.RefundExceedsOriginalError;
export import canonicalPayload = ledgerPosting.canonicalPayload;
export import samePayload = ledgerPosting.samePayload;
export import reversesOf = ledgerPosting.reversesOf;
export import buildReversal = ledgerPosting.buildReversal;
export import REVERSAL_KIND = ledgerPosting.REVERSAL_KIND;
export import reversalKey = ledgerPosting.reversalKey;
export import chainPayload = ledgerPosting.chainPayload;
export import nextHash = ledgerPosting.nextHash;
export import verifyChain = ledgerPosting.verifyChain;
export import GENESIS_HASH = ledgerPosting.GENESIS_HASH;
export type Sha256Hex = ledgerPosting.Sha256Hex;
export type ChainLink = ledgerPosting.ChainLink;
export type ChainedEntry = ledgerPosting.ChainedEntry;
export type ChainFailure = ledgerPosting.ChainFailure;
export type ChainVerification = ledgerPosting.ChainVerification;
export import voucherRelease = ledgerPosting.voucherRelease;
export import planRefund = ledgerPosting.planRefund;
export type RefundLineState = ledgerPosting.RefundLineState;
export type RefundItem = ledgerPosting.RefundItem;
export type OriginalTender = ledgerPosting.OriginalTender;
export type RefundPlanInput = ledgerPosting.RefundPlanInput;
export type RefundPlan = ledgerPosting.RefundPlan;
export import requiresGiftCardFlag = ledgerPosting.requiresGiftCardFlag;
export import keyOf = ledgerPosting.keyOf;
export import planOrder = ledgerPosting.planOrder;
export import buildEntry = ledgerPosting.buildEntry;
export import refundPlanOf = ledgerPosting.refundPlanOf;
export type PostingMeta = ledgerPosting.PostingMeta;
export type ExternalTender = ledgerPosting.ExternalTender;
export type StoreOrderCommand = ledgerPosting.StoreOrderCommand;
export type PlatformVoucher = ledgerPosting.PlatformVoucher;
export type OrderCommandBase = ledgerPosting.OrderCommandBase;
export type PostingCommand = ledgerPosting.PostingCommand;
export type PromoSub = ledgerPosting.PromoSub;
export type PostingCommandType = ledgerPosting.PostingCommandType;
export type OrderPlan = ledgerPosting.OrderPlan;
export import checkTrialBalance = ledgerPosting.checkTrialBalance;
export import trialBalanceOfEntries = ledgerPosting.trialBalanceOfEntries;
export import storeCreditDrift = ledgerPosting.storeCreditDrift;
export import buildIntegrityReport = ledgerPosting.buildIntegrityReport;
export type StoredBalance = ledgerPosting.StoredBalance;
export type TrialBalanceReport = ledgerPosting.TrialBalanceReport;
export type ProjectionRow = ledgerPosting.ProjectionRow;
export type DriftRow = ledgerPosting.DriftRow;
export type IntegrityReport = ledgerPosting.IntegrityReport;
export {
  chart,
  describeAccount,
  createJournalEntry,
  derivedBalance,
  money,
  DomainError,
  InvalidEntryError,
  UnbalancedEntryError,
  trialBalance,
  type AccountId,
  type JournalEntry,
  type Money,
  type Posting,
  type EntryMeta,
} from "@outlet/domain";
