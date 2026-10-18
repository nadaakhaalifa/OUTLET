import { guestRule, type GuestFeature } from "../guest/capabilities";
import type { MeRow, MeRowId } from "../navigation/model";

/** Me row -> guest feature. Rows without an entry are a plain device feature (wishlists, help, settings). */
const ROW_FEATURE: Readonly<Partial<Record<MeRowId, GuestFeature>>> = {
  orders: "orders", wallet: "wallet", budget: "budget", sizeProfile: "sizeProfile", addresses: "addresses", plus: "plus", autoBuy: "autoBuy",
  rewards: "rewards", giftCards: "giftCards", outfitCalendar: "outfitCalendar", wardrobe: "wardrobe", stylist: "stylist", privacy: "guestPrivacy",
};

/** Rows a guest sees: only features with a guest entry point (empty, local or readable). Everything else is hidden, never a prompt. */
export function guestMeRows(rows: readonly MeRow[]): readonly MeRow[] {
  return rows.filter((r) => { const f = ROW_FEATURE[r.id]; return f === undefined || guestRule(f).entry; });
}

export function meRowFeature(id: MeRowId): GuestFeature | undefined { return ROW_FEATURE[id]; }
