import { money } from "../money";
import type { Promotion } from "./types";

const T0 = Date.UTC(2026, 9, 1);
export const NOW = Date.UTC(2026, 9, 10, 9, 0, 0);

export const S1 = "00000000-0000-4000-a000-000000000001";
export const S2 = "00000000-0000-4000-a000-000000000002";
export const S3 = "00000000-0000-4000-a000-000000000003";

let n = 0;
/** Test fixture builder: an active platform percent code, overridable. */
export function promo(over: Partial<Promotion> = {}): Promotion {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    version: 1,
    owner: { kind: "platform" },
    scope: "order",
    value: { kind: "percent", percentBps: 1000 },
    code: `CODE${n}`,
    autoApply: false,
    funding: { platformPct: 100, sellerPct: 0 },
    targeting: { storeIds: [], skuIds: [], paymentMethods: [], plusOnly: false },
    minOrder: null,
    maxDiscount: null,
    perUserCap: null,
    perDayCap: null,
    totalBudget: null,
    startsAtMs: T0,
    endsAtMs: T0 + 90 * 86_400_000,
    status: "active",
    ...over,
  };
}

export const egp = (pounds: bigint) => money(pounds * 100n);
