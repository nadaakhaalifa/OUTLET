import type { RateBudget } from "../../platform/rate-limit/budgets.js";

/** Applicant writes (draft, document, IBAN, submit): per user, fail closed. Local to the module so the shared budget table stays untouched. */
export const SELLER_ONBOARDING_BUDGET: RateBudget = Object.freeze({ name: "seller_onboarding", limit: 30, periodMs: 60 * 60 * 1000, keys: ["user"] as const, failMode: "closed", source: "default" });
