/**
 * Single seam to the pure budget domain. Aliases only; no behaviour.
 *
 * BUILD NOTE: packages/domain/src/index.ts did not yet export `budget` when this module was
 * built (that file is owned by the integrator). The seam therefore imports the domain folder
 * directly. After the integrator adds `export * as budget from "./budget";` replace the next
 * line with `import { budget } from "@outlet/domain";` and the rest of this file is unchanged.
 */
import { budget } from "@outlet/domain";

export type AffordabilityContext = budget.AffordabilityContext;
export type BudgetSettings = budget.BudgetSettings;
export type CapDecision = budget.CapDecision;
export type CapMode = budget.CapMode;
export type Commitment = budget.Commitment;
export type CommitmentSource = budget.CommitmentSource;
export type Cycle = budget.Cycle;
export type CycleTotals = budget.CycleTotals;
export type Plan = budget.Plan;
export type PlanCycle = budget.PlanCycle;
export type PlanItem = budget.PlanItem;
export type PlanPriority = budget.PlanPriority;
export type Remaining = budget.Remaining;
export type SpendEvent = budget.SpendEvent;
export type SpendKind = budget.SpendKind;
export type SpendLine = budget.SpendLine;
export type BudgetValidation = budget.BudgetValidation;

export import AFFORDABILITY_CONTEXTS = budget.AFFORDABILITY_CONTEXTS;
export import BUDGET_LIMITS = budget.BUDGET_LIMITS;
export import CAP_MODES = budget.CAP_MODES;
export import COMMITMENT_SOURCES = budget.COMMITMENT_SOURCES;
export import PLAN_PRIORITIES = budget.PLAN_PRIORITIES;
export import SPEND_KINDS = budget.SPEND_KINDS;
export import breakdown = budget.breakdown;
export import computeRemaining = budget.computeRemaining;
export import cycleFor = budget.cycleFor;
export import cycleTotals = budget.cycleTotals;
export import effectiveCommitments = budget.effectiveCommitments;
export import evaluateCap = budget.evaluateCap;
export import installmentsDue = budget.installmentsDue;
export import planPurchases = budget.planPurchases;
export import previousCycle = budget.previousCycle;
export import priceCeiling = budget.priceCeiling;
export import unlockAt = budget.unlockAt;
export import validateBudget = budget.validateBudget;
