/** Trademark owner comparison and auto-check aggregation (ADR-0031 decision 6: evidence only, humans decide). Pure. */
import { SIMILAR_NAME_THRESHOLD, compareNormalisedNames, normaliseBrandName, type NameMatchReason } from "./name";
import { DEFAULT_COUNTRY_POLICY, requiresDualApproval, type BrandKind, type CountryPolicy, type SanctionsOutcome } from "./policy";

export const OWNER_MATCH_THRESHOLD = 90;
export type OwnerMatchBand = "match" | "weak" | "mismatch";

export interface OwnerMatch {
  readonly score: number;
  readonly band: OwnerMatchBand;
  readonly reasons: readonly NameMatchReason[];
}

/** Registered owner vs applicant legal name: explainable fuzzy score. VERIFY thresholds with Trust & Safety. */
export function compareOwner(applicantLegalName: string, registeredOwner: string): OwnerMatch {
  const cmp = compareNormalisedNames(normaliseBrandName(applicantLegalName), normaliseBrandName(registeredOwner));
  const band: OwnerMatchBand = cmp.score >= OWNER_MATCH_THRESHOLD ? "match" : cmp.score >= SIMILAR_NAME_THRESHOLD - 15 ? "weak" : "mismatch";
  return { score: cmp.score, band, reasons: cmp.reasons };
}

export const CHECK_CODES = ["country_policy", "domain_verified", "trademark_owner", "sanctions", "duplicate_claim"] as const;
export type CheckCode = (typeof CHECK_CODES)[number];
export type CheckResult = "pass" | "warn" | "fail" | "error" | "skipped";
export type RiskBand = "low" | "medium" | "high";

export interface AutoCheck {
  readonly code: CheckCode;
  readonly result: CheckResult;
  readonly reasons: readonly string[];
  readonly evidenceIds: readonly string[];
}

export interface Contribution {
  readonly code: CheckCode;
  readonly level: RiskBand;
  readonly reason: string;
}

export interface AutoCheckReport {
  readonly ruleVersion: 1;
  readonly applicationId: string;
  readonly ranAtMs: number;
  readonly checks: readonly AutoCheck[];
  readonly contributions: readonly Contribution[];
  readonly risk: RiskBand;
  readonly reasons: readonly string[];
  readonly dualApprovalRequired: boolean;
  readonly forceManualTrademark: boolean;
}

const RANK: Record<RiskBand, number> = { low: 0, medium: 1, high: 2 };

/** Deterministic: same inputs give the same report (checks are ordered by CHECK_CODES). */
export function aggregateAutoChecks(input: {
  readonly applicationId: string;
  readonly kind: BrandKind;
  readonly country: string;
  readonly ranAtMs: number;
  readonly checks: readonly AutoCheck[];
  readonly policy?: CountryPolicy;
}): AutoCheckReport {
  const policy = input.policy ?? DEFAULT_COUNTRY_POLICY;
  const byCode = new Map(input.checks.map((c) => [c.code, c]));
  const checks = CHECK_CODES.flatMap((code) => {
    const c = byCode.get(code);
    return c === undefined ? [] : [{ ...c, reasons: [...c.reasons].sort(), evidenceIds: [...c.evidenceIds].sort() }];
  });
  const contributions: Contribution[] = [];
  const add = (code: CheckCode, level: RiskBand, reason: string) => contributions.push({ code, level, reason });
  for (const c of checks) {
    if (c.result === "error") add(c.code, "medium", `check_error_${c.code}`);
    switch (c.code) {
      case "country_policy":
        if (c.result === "fail") add(c.code, "high", "country_not_supported");
        break;
      case "domain_verified":
        if (c.result === "fail" || c.result === "warn") add(c.code, input.kind === "global" ? "medium" : "low", "domain_not_verified");
        break;
      case "trademark_owner":
        if (c.result === "fail") add(c.code, "high", "trademark_owner_mismatch");
        else if (c.result === "warn") add(c.code, "medium", "trademark_owner_weak_match");
        break;
      case "sanctions":
        if (c.result === "fail") add(c.code, "high", "sanctions_hit");
        else if (c.result === "warn") add(c.code, "high", "sanctions_possible_match");
        break;
      case "duplicate_claim":
        if (c.result === "fail" || c.result === "warn") add(c.code, "medium", "duplicate_claim");
        break;
    }
  }
  const sanctions = byCode.get("sanctions");
  const sanctionsOutcome: SanctionsOutcome = sanctions === undefined ? "not_run" : sanctions.result === "pass" ? "clear" : sanctions.result === "warn" ? "warn" : sanctions.result === "fail" ? "fail" : sanctions.result === "error" ? "error" : "not_run";
  const highRiskGlobal = input.kind === "global" && requiresDualApproval({ kind: "global", country: input.country, sanctions: "clear" }, policy);
  if (highRiskGlobal) add("country_policy", "high", "high_risk_country");
  const risk = contributions.reduce<RiskBand>((r, c) => (RANK[c.level] > RANK[r] ? c.level : r), "low");
  const trademark = byCode.get("trademark_owner");
  return {
    ruleVersion: 1,
    applicationId: input.applicationId,
    ranAtMs: input.ranAtMs,
    checks,
    contributions: contributions.sort((a, b) => (a.code + a.reason < b.code + b.reason ? -1 : 1)),
    risk,
    reasons: [...new Set(contributions.map((c) => c.reason))].sort(),
    dualApprovalRequired: requiresDualApproval({ kind: input.kind, country: input.country, sanctions: sanctionsOutcome }, policy),
    forceManualTrademark: trademark !== undefined && trademark.result !== "pass" && trademark.result !== "skipped",
  };
}
