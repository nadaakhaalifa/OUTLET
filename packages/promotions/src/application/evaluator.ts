import { withDbContext } from "@outlet/db";
import { autoBest, evaluate, pruneCandidates } from "../domain/evaluate.js";
import { requiresCode } from "../domain/rules.js";
import { displayLabels } from "../domain/labels.js";
import type { DisplayLabel } from "../domain/labels.js";
import type { EvalBag, EvalContext, EvaluationResult, PromotionCandidate, UsageSnapshot } from "../domain/types.js";
import type { PromotionsDeps } from "./ports.js";
import { PROMOTION_COLS, toCandidate } from "./rows.js";
import type { PromotionRow } from "./rows.js";
import { VoucherService } from "./voucher-service.js";

export interface QuoteEvaluation {
  readonly result: EvaluationResult;
  readonly labels: readonly DisplayLabel[];
  readonly selectedIds: readonly string[];
  /** entered codes that did not resolve (shown as "code not valid", never why) */
  readonly invalidCodes: readonly string[];
  readonly prunedIds: readonly string[];
  /** true when the promotions.enabled kill switch is off: no discounts are applied */
  readonly disabled: boolean;
}

/** Quote-time evaluation, used by checkout later. Pure reads (no reservation): the reservation happens at place time through VoucherService. */
export class PromotionEvaluator {
  private readonly vouchers: VoucherService;
  constructor(private readonly deps: PromotionsDeps) {
    this.vouchers = new VoucherService(deps);
  }

  /** Stable entry point: evaluateForQuote(bag, ctx, { codes }). Fails closed to "no discounts" when the kill switch is off. */
  async evaluateForQuote(bag: EvalBag, ctx: EvalContext, opts: { readonly codes?: readonly string[] } = {}): Promise<QuoteEvaluation> {
    if (!(await this.deps.kill.isEnabled())) {
      const result = evaluate(bag, ctx, []);
      return { result, labels: [], selectedIds: [], invalidCodes: [], prunedIds: [], disabled: true };
    }
    const storeIds = bag.stores.map((s) => s.storeId);
    const loaded = await withDbContext(this.deps.client, { kind: "user", marketId: this.deps.marketId, userId: ctx.userId }, async (tx) => {
      const rows = (
        await tx.query<PromotionRow>(
          `SELECT ${PROMOTION_COLS} FROM promotions WHERE market_id = $1 AND status = 'ACTIVE' AND starts_at <= $2 AND ends_at > $2
             AND (store_id IS NULL OR store_id = ANY($3::uuid[])) ORDER BY id`,
          [this.deps.marketId, ctx.now.toISOString(), storeIds],
        )
      ).rows;
      const candidates: PromotionCandidate[] = rows.filter((r) => !requiresCode(r.stacking_class)).map((r) => toCandidate(r));
      const invalidCodes: string[] = [];
      for (const raw of [...new Set(opts.codes ?? [])]) {
        const hit = await this.vouchers.resolveCode(tx, ctx.userId, raw);
        if (hit === null || !requiresCode(hit.promotion.stacking_class) || (hit.promotion.store_id !== null && !storeIds.includes(hit.promotion.store_id))) invalidCodes.push(raw);
        else if (!candidates.some((c) => c.id === hit.promotion.id)) candidates.push(toCandidate(hit.promotion, hit.voucherId));
      }
      const usage = new Map<string, UsageSnapshot>();
      const ids = candidates.map((c) => c.id);
      if (ids.length > 0) {
        const total = await tx.query<{ promotion_id: string; used_minor: string | bigint; used_count: number }>("SELECT promotion_id, used_minor, used_count FROM promotion_usage WHERE promotion_id = ANY($1::uuid[])", [ids]);
        const mine = await tx.query<{ promotion_id: string; n: string | number }>(
          `SELECT r.promotion_id, count(*) AS n FROM voucher_redemptions r WHERE r.user_id = $1 AND r.promotion_id = ANY($2::uuid[]) AND r.kind = 'reserved'
             AND NOT EXISTS (SELECT 1 FROM voucher_redemptions x WHERE x.ref_id = r.id AND x.kind IN ('released', 'reinstated')) GROUP BY r.promotion_id`,
          [ctx.userId, ids],
        );
        for (const id of ids) {
          const t = total.rows.find((x) => x.promotion_id === id);
          usage.set(id, { userUses: Number(mine.rows.find((x) => x.promotion_id === id)?.n ?? 0), totalUses: t?.used_count ?? 0, usedMinor: BigInt(t?.used_minor ?? 0) });
        }
      }
      return { candidates, invalidCodes, usage: usage };
    });
    const { kept, prunedIds } = pruneCandidates(bag, ctx, loaded.candidates, loaded.usage);
    const best = autoBest(bag, ctx, kept, loaded.usage);
    return { result: best.result, labels: displayLabels(best.result), selectedIds: best.selectedIds, invalidCodes: loaded.invalidCodes, prunedIds, disabled: false };
  }
}
