import { parseRules } from "../src/index.js";
import type { EvalBag, EvalContext, PromotionCandidate, Rules } from "../src/index.js";

export const NOW = new Date("2030-06-01T12:00:00.000Z");
export const A = "00000000-0000-4000-8000-00000000000a";
export const B = "00000000-0000-4000-8000-00000000000b";

export const ctx = (o: Partial<EvalContext> = {}): EvalContext => ({
  now: NOW, userId: "00000000-0000-4000-8000-0000000000u1".replace("u", "0"), isPlus: false, isFirstOrder: false, birthdayToday: false, daysSinceLastOrder: null,
  followedStoreIds: [], paymentMethod: "card", city: null, segments: [], tier: null, ...o,
});

export const bag = (): EvalBag => ({
  currency: "EGP",
  stores: [
    { storeId: A, shippingFeeMinor: 6000n, lines: [
      { id: "l1", storeId: A, productId: "p1", categoryId: "dress", qty: 2, unitMinor: 50_000n, vatBp: 1400 },
      { id: "l2", storeId: A, productId: "p2", categoryId: "shoes", qty: 1, unitMinor: 30_000n, vatBp: 1400 },
    ] },
    { storeId: B, shippingFeeMinor: 5000n, lines: [{ id: "l3", storeId: B, productId: "p3", categoryId: "dress", qty: 1, unitMinor: 40_001n, vatBp: 1400 }] },
  ],
});

export interface CandOpts { id: string; rules?: unknown; storeId?: string | null; type?: PromotionCandidate["type"]; cls?: PromotionCandidate["stackingClass"]; owner?: PromotionCandidate["ownerType"];
  fp?: number; fs?: number; min?: bigint | null; max?: bigint | null; budget?: bigint | null; perUser?: number | null; total?: number | null; voucherId?: string | null; status?: PromotionCandidate["status"] }

export const cand = (o: CandOpts): PromotionCandidate => {
  const storeId = o.storeId ?? null;
  const rules: Rules = parseRules(o.rules ?? { level: "order", discount: { kind: "percent", bps: 1000 } });
  return {
    id: o.id, version: 1, ownerType: o.owner ?? (storeId === null ? "platform" : "store"), storeId, type: o.type ?? "percent", stackingClass: o.cls ?? "auto", rules,
    fundingPlatformBp: o.fp ?? (storeId === null ? 10_000 : 0), fundingSellerBp: o.fs ?? (storeId === null ? 0 : 10_000), perUserLimit: o.perUser ?? null, minOrderMinor: o.min ?? null,
    maxDiscountMinor: o.max ?? null, budgetMinor: o.budget ?? null, totalLimit: o.total ?? null, currency: "EGP", startsAt: new Date("2030-01-01T00:00:00Z"), endsAt: new Date("2031-01-01T00:00:00Z"),
    status: o.status ?? "ACTIVE", voucherId: o.voucherId ?? null,
  };
};
