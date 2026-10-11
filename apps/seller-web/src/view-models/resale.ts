import type { ResaleListing } from "../api/schemas-phase2";
import type { Locale, MessageKey } from "../i18n";
import { formatDateTime, formatMoney } from "../lib/format";

const STATUS = new Set(["LISTED", "ACTIVE", "SOLD", "WITHDRAWN"]);

export interface ResaleRowVM {
  readonly id: string;
  readonly sku: string;
  readonly gradeKey: MessageKey;
  readonly grade: "A" | "B" | "C";
  /** The only price shown. There is deliberately no reference/original price or percentage field. */
  readonly price: string;
  readonly statusKey: MessageKey;
  readonly ownership: string;
  readonly listedAt: string;
  readonly soldAt: string | null;
  readonly canWithdraw: boolean;
}

export function resaleRows(items: readonly ResaleListing[], locale: Locale): readonly ResaleRowVM[] {
  return items.map((l) => {
    const s = l.status.toUpperCase();
    return {
      id: l.id,
      sku: l.sku_id,
      grade: l.grade,
      gradeKey: `resale.grade.${l.grade}` as MessageKey,
      price: formatMoney(l.price_piastres, locale),
      statusKey: STATUS.has(s) ? (`resale.status.${s}` as MessageKey) : "resale.status.unknown",
      ownership: l.ownership,
      listedAt: formatDateTime(l.listed_at, locale),
      soldAt: l.sold_at === null ? null : formatDateTime(l.sold_at, locale),
      canWithdraw: s === "LISTED" || s === "ACTIVE",
    };
  });
}
