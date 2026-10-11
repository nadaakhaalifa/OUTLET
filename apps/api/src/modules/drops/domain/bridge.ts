/**
 * Single seam to the pure drops domain (packages/domain/src/drops). Aliases only, no behaviour.
 *
 * NOTE for the integrator: once `export * as drops from "./drops";` is added to
 * packages/domain/src/index.ts, replace the relative import below with
 * `import { drops } from "@outlet/domain";` and re-export the same names (ADR-0018).
 */
import { drops } from "@outlet/domain";
export import DEFAULT_SOCIAL_PROOF = drops.DEFAULT_SOCIAL_PROOF;
export import DROP_TYPES = drops.DROP_TYPES;
export import EARLY_ACCESS_MS = drops.EARLY_ACCESS_MS;
export import HOUR_MS = drops.HOUR_MS;
export import checkEdit = drops.checkEdit;
export import checkPurchaseLimit = drops.checkPurchaseLimit;
export import dueEvent = drops.dueEvent;
export import ladderPriceAt = drops.ladderPriceAt;
export import needsRefresh = drops.needsRefresh;
export import nextState = drops.nextState;
export import socialProof = drops.socialProof;
export import validateDraft = drops.validateDraft;
export type Drop = drops.Drop;
export type DropDraft = drops.DropDraft;
export type DropItem = drops.DropItem;
export type DropLimits = drops.DropLimits;
export type DropType = drops.DropType;
export type EditPatch = drops.EditPatch;
export type EditVerdict = drops.EditVerdict;
export type FieldError = drops.FieldError;
export type LadderStep = drops.LadderStep;
export type MysteryTerms = drops.MysteryTerms;
export type SocialProof = drops.SocialProof;
export type SocialProofConfig = drops.SocialProofConfig;
export {
  DROP_STATES,
  dropMachine,
  type DropEvent as DropMachineEvent,
  type DropState,
} from "@outlet/domain";
