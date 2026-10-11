/**
 * Single seam to the pure promotions domain (and money) in packages/domain. Only this file imports the
 * shared package for the promotions module; everything else imports `./bridge`.
 *
 * Boundary (spec 12, 17): this module must never import the budget module or budget tables.
 * `test/no-budget-import.test.ts` enforces it on every source file here.
 */
import { promotions } from "@outlet/domain";

export * from "@outlet/domain";
export { promotions };
export type Promotion = promotions.Promotion;
export type EvaluationResult = promotions.EvaluationResult;
