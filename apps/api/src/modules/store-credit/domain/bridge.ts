/** Single seam to the pure domain: the `storeCredit` namespace of @outlet/domain plus chart and ledger helpers. Aliases only. */
export {
  chart,
  createJournalEntry,
  giftCardRedeemed,
  money,
  storeCreditExpired,
  storeCreditGranted,
  subBalanceKey,
  type EntryMeta,
  type JournalEntry,
  type Money,
  type StoreCreditSub,
} from "@outlet/domain";
import { storeCredit } from "@outlet/domain";
export import InvalidCreditInputError = storeCredit.InvalidCreditInputError;
export import GiftCardSalesDisabledError = storeCredit.GiftCardSalesDisabledError;
export import addMonthsUtc = storeCredit.addMonthsUtc;
export import expiryFor = storeCredit.expiryFor;
export import parseSubKey = storeCredit.parseSubKey;
export import DAY_MS = storeCredit.DAY_MS;
export type SubKind = storeCredit.SubKind;
export type SubRule = storeCredit.SubRule;
export import SUB_RULES = storeCredit.SUB_RULES;
export import EXPIRING_PLATFORM_KINDS = storeCredit.EXPIRING_PLATFORM_KINDS;
export import availableOf = storeCredit.availableOf;
export import planLotSpend = storeCredit.planLotSpend;
export import balancesOf = storeCredit.balancesOf;
export import expiringSoon = storeCredit.expiringSoon;
export import planExpirySweep = storeCredit.planExpirySweep;
export import reconcileProjection = storeCredit.reconcileProjection;
export type CreditLot = storeCredit.CreditLot;
export type LotTake = storeCredit.LotTake;
export import isExpired = storeCredit.isExpired;
export type SubBalanceView = storeCredit.SubBalanceView;
export type ExpiringSoon = storeCredit.ExpiringSoon;
export type ProjectionDrift = storeCredit.ProjectionDrift;
export import labelFor = storeCredit.labelFor;
export import violatesWording = storeCredit.violatesWording;
export import collectStrings = storeCredit.collectStrings;
export import FORBIDDEN_WORDING = storeCredit.FORBIDDEN_WORDING;
export type Label = storeCredit.Label;
export import WALLET_TITLE = storeCredit.WALLET_TITLE;
export import giftCardSalesGate = storeCredit.giftCardSalesGate;
export type GiftCardSalesGate = storeCredit.GiftCardSalesGate;
