export interface ArmOutcome {
  readonly orders: number;
  readonly returned: number;
  readonly complaints: number;
}

/** A/B guardrail configuration. Rates are compared in basis points of delivered orders. */
export interface GuardrailConfig {
  readonly minOrdersPerArm: number;
  /** Treatment return rate may exceed control by at most this many bps (absolute). */
  readonly maxReturnRateIncreaseBps: number;
  readonly maxComplaintRateIncreaseBps: number;
}

export const DEFAULT_GUARDRAIL_CONFIG: GuardrailConfig = {
  minOrdersPerArm: 500,
  maxReturnRateIncreaseBps: 100,
  maxComplaintRateIncreaseBps: 30,
};

export type GuardrailDecision = "continue" | "halt" | "insufficient_data";
export interface GuardrailResult {
  readonly decision: GuardrailDecision;
  readonly breaches: readonly ("return_rate" | "complaint_rate")[];
  readonly returnRateDeltaBps: number | null;
  readonly complaintRateDeltaBps: number | null;
}

const bps = (num: number, den: number): number => Math.round((num * 10_000) / den);

export function evaluateGuardrails(cfg: GuardrailConfig, control: ArmOutcome, treatment: ArmOutcome): GuardrailResult {
  if (control.orders < cfg.minOrdersPerArm || treatment.orders < cfg.minOrdersPerArm) {
    return { decision: "insufficient_data", breaches: [], returnRateDeltaBps: null, complaintRateDeltaBps: null };
  }
  const rd = bps(treatment.returned, treatment.orders) - bps(control.returned, control.orders);
  const cd = bps(treatment.complaints, treatment.orders) - bps(control.complaints, control.orders);
  const breaches: ("return_rate" | "complaint_rate")[] = [];
  if (rd > cfg.maxReturnRateIncreaseBps) breaches.push("return_rate");
  if (cd > cfg.maxComplaintRateIncreaseBps) breaches.push("complaint_rate");
  return { decision: breaches.length > 0 ? "halt" : "continue", breaches, returnRateDeltaBps: rd, complaintRateDeltaBps: cd };
}
