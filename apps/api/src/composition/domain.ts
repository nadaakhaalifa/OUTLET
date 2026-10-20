/** Single seam from the composition layer to the pure domain (public @outlet/domain entry only). */
import { chart, checkout, ledgerPosting, money, orderRecognised, storeCredit } from "@outlet/domain";

export { chart, checkout, money, orderRecognised };
export type { JournalEntry, Money, SubBalanceState } from "@outlet/domain";
export const buildEntry = ledgerPosting.buildEntry;
export type PostingCommand = ledgerPosting.PostingCommand;

/** Null for keys that are not store-credit sub-balances (so foreign accounts never leak in). */
export function parseSubKeyOrNull(key: string): ReturnType<typeof storeCredit.parseSubKey> | null {
  try {
    return storeCredit.parseSubKey(key);
  } catch {
    return null;
  }
}
export const parseSubKey = storeCredit.parseSubKey;
export const availableOf = storeCredit.availableOf;
