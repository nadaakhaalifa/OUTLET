import type { MergeNote } from "./merge";
import { MAX_BAG_LINES, MAX_UNITS_PER_ITEM } from "./schema";

/**
 * The sentence for one merge-summary note: an i18n key under `guestMerge.*` plus its params. Shared by the Checkout gate
 * and the quiet sign-in. Pass `num` to localise digits (Arabic numerals setting); without it numbers stay as numbers.
 */
export function noteText(n: MergeNote, num?: (v: number) => string): { readonly key: string; readonly params: Record<string, string | number> } {
  const f = (v: number): string | number => (num === undefined ? v : num(v));
  switch (n.kind) {
    case "kept_larger":
      return { key: "guestMerge.keptLarger", params: { title: n.title, local: f(n.localQty), account: f(n.accountQty ?? 0), qty: f(n.qty ?? n.localQty) } };
    case "moved_to_saved":
      return { key: n.reason === "over_cap" ? "guestMerge.savedOverCapLine" : "guestMerge.savedUnavailableLine", params: { title: n.title, max: f(MAX_BAG_LINES) } };
    case "moved_to_bag":
      return { key: "guestMerge.movedToBag", params: { title: n.title } };
    case "unavailable":
      return { key: "guestMerge.unavailable", params: { title: n.title } };
    case "store_suspended":
      return { key: "guestMerge.storeSuspended", params: { title: n.title } };
    case "clamped":
      return { key: "guestMerge.clamped", params: { title: n.title, qty: f(n.qty ?? MAX_UNITS_PER_ITEM) } };
  }
}
