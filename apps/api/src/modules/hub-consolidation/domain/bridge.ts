/**
 * Single seam to the pure hub domain (packages/domain/src/hub). Aliases and re-exports only, no
 * behaviour (ADR-0018). Once `export * as hub from "./hub"` is added to packages/domain/src/index.ts
 * the integrator may swap this for `import { hub } from "@outlet/domain"`.
 */
import { hub } from "@outlet/domain";
export import DEFAULT_CARBON_FACTORS = hub.DEFAULT_CARBON_FACTORS;
export import DEFAULT_HUB_CONFIG = hub.DEFAULT_HUB_CONFIG;
export import InvalidHubInputError = hub.InvalidHubInputError;
export import InvalidLegTransitionError = hub.InvalidLegTransitionError;
export import LEG_STATES = hub.LEG_STATES;
export import LEG_TRANSITIONS = hub.LEG_TRANSITIONS;
export import MS_PER_HOUR = hub.MS_PER_HOUR;
export import RECEIPT_CONDITIONS = hub.RECEIPT_CONDITIONS;
export import canMoveLeg = hub.canMoveLeg;
export import chooseCourier = hub.chooseCourier;
export import compareConsolidation = hub.compareConsolidation;
export import estimateParcelGco2e = hub.estimateParcelGco2e;
export import handoffOverdue = hub.handoffOverdue;
export import isTerminalLeg = hub.isTerminalLeg;
export import moveLeg = hub.moveLeg;
export import p80 = hub.p80;
export import planConsolidation = hub.planConsolidation;
export import splitFee = hub.splitFee;
export type CarbonEstimate = hub.CarbonEstimate;
export type CourierCandidate = hub.CourierCandidate;
export type CourierChoice = hub.CourierChoice;
export type HubConfig = hub.HubConfig;
export type HubLeg = hub.HubLeg;
export type LegState = hub.LegState;
export type PlanDecision = hub.PlanDecision;
export type PlannedParcel = hub.PlannedParcel;
export type ReceiptCondition = hub.ReceiptCondition;
export type { Money } from "@outlet/domain";
