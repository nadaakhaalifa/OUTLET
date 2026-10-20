import { applySet, amountsFor, gate, newBasket, payableOf } from "./apply";
import { chooseBest, compareText, violatesStacking } from "./stacking";
import { normalizeCode } from "./validate";
import {
  DEFAULT_STACKING_POLICY,
  type EvalRequest,
  type EvaluationResult,
  type Promotion,
  type RejectedPromotion,
  type RejectReason,
  type StackingPolicy,
} from "./types";

const MAX_CODES = 5;

/**
 * Deterministic promotion evaluation (spec 17). Pure: the same request and promotion pool always give
 * the same result, so re-evaluation is idempotent. The pool may contain promotions that are not
 * eligible; each is re-checked here and reported in `rejected`.
 */
export function evaluatePromotions(
  req: EvalRequest,
  pool: readonly Promotion[],
  policy: StackingPolicy = DEFAULT_STACKING_POLICY,
): EvaluationResult {
  const rejected: RejectedPromotion[] = [];
  const reject = (p: Promotion | null, code: string | null, reason: RejectReason): void => {
    rejected.push({ code: p?.code ?? code, promotionId: p?.id ?? null, reason });
  };

  const entered: string[] = [];
  for (const raw of req.codes) {
    const c = normalizeCode(raw);
    if (c === "" || entered.includes(c)) continue;
    if (entered.length >= MAX_CODES) {
      reject(null, c, "too_many_codes");
      continue;
    }
    entered.push(c);
  }

  const byId = new Map<string, Promotion>();
  for (const p of pool) if (!byId.has(p.id)) byId.set(p.id, p);
  const promos = [...byId.values()];

  const base = newBasket(req.lines, req.shippingFees, req.isPlus);
  const candidates: { p: Promotion; standalone: bigint }[] = [];
  const matchedCodes = new Set<string>();
  for (const p of promos) {
    const isEntered = p.code !== null && entered.includes(p.code);
    if (isEntered && p.code !== null) matchedCodes.add(p.code);
    if (!isEntered && !(p.autoApply && p.code === null)) continue;
    const g = gate(p, {
      atMs: req.atMs,
      paymentMethod: req.paymentMethod,
      isPlus: req.isPlus,
      usage: req.usage.get(p.id),
    });
    if (g !== null) {
      // Auto promotions that simply are not live are not worth reporting to the shopper.
      if (isEntered || (g !== "not_active" && g !== "not_started" && g !== "expired")) reject(p, null, g);
      continue;
    }
    const a = amountsFor(p, base, req.usage.get(p.id));
    const total =
      a.lines.reduce((s, x) => s + x, 0n) + [...a.shipping.values()].reduce((s, x) => s + x, 0n);
    if (total <= 0n) {
      if (isEntered) reject(p, null, a.emptyReason ?? "no_discount");
      continue;
    }
    candidates.push({ p, standalone: total });
  }
  for (const c of entered) if (!matchedCodes.has(c)) reject(null, c, "unknown_code");

  candidates.sort((a, b) =>
    a.standalone === b.standalone ? compareText(a.p.id, b.p.id) : a.standalone > b.standalone ? -1 : 1,
  );
  const kept = candidates.slice(0, policy.maxCandidates);
  for (const c of candidates.slice(policy.maxCandidates)) reject(c.p, null, "candidate_limit");

  const keptPromos = kept.map((c) => c.p);
  const best = chooseBest(keptPromos, policy, (subset) => payableOf(applySet(subset, base, req.usage).basket));
  const { applied, basket } = applySet(best.subset, base, req.usage);

  const chosenIds = new Set(applied.map((a) => a.promotionId));
  for (const p of keptPromos) {
    if (chosenIds.has(p.id)) continue;
    const withIt = [...best.subset, p];
    reject(p, null, violatesStacking(withIt, policy) ? "stacking_conflict" : "no_additional_saving");
  }

  let merchSub = 0n;
  let merchLeft = 0n;
  const lines = req.lines.map((_, lineIndex) => {
    const subtotal = base.listTotals[lineIndex] ?? 0n;
    const payable = basket.remaining[lineIndex] ?? 0n;
    merchSub += subtotal;
    merchLeft += payable;
    return { lineIndex, subtotal, discount: subtotal - payable, payable };
  });
  let feeTotal = 0n;
  let feeLeft = 0n;
  const shipping = [...base.fees.keys()].sort().map((storeId) => {
    const fee = base.fees.get(storeId) ?? 0n;
    const payable = basket.fees.get(storeId) ?? 0n;
    feeTotal += fee;
    feeLeft += payable;
    return { storeId, fee, discount: fee - payable, payable };
  });

  rejected.sort((a, b) =>
    compareText(`${a.promotionId ?? ""}|${a.code ?? ""}`, `${b.promotionId ?? ""}|${b.code ?? ""}`),
  );

  return {
    policyVersion: policy.version,
    applied,
    rejected,
    lines,
    shipping,
    merchandiseSubtotal: merchSub,
    merchandiseDiscount: merchSub - merchLeft,
    shippingFee: feeTotal,
    shippingDiscount: feeTotal - feeLeft,
    totalDiscount: merchSub - merchLeft + (feeTotal - feeLeft),
    payableTotal: merchLeft + feeLeft,
  };
}
