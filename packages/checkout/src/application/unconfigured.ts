import type { RiskPort } from "../ports.js";

/** Fail-closed default (ADR-0029): with no risk adapter wired, cash on delivery is blocked, never allowed. */
export class UnconfiguredRisk implements RiskPort {
  assessCod(): ReturnType<RiskPort["assessCod"]> {
    return Promise.resolve({ decision: "block", reasonCodes: ["risk_unconfigured"] });
  }
}
