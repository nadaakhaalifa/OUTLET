/**
 * Single seam to the pure stylist domain (packages/domain/src/stylist). Aliases only, no behaviour.
 *
 * NOTE for the integrator: once `export * as stylist from "./stylist";` is added to
 * packages/domain/src/index.ts, replace the relative import below with
 * `import { stylist } from "@outlet/domain";` and re-export the same names (ADR-0018).
 */
import { stylist } from "@outlet/domain";
export import DEFAULT_OPTIMIZER_CONFIG = stylist.DEFAULT_OPTIMIZER_CONFIG;
export import SLOTS = stylist.SLOTS;
export import checkOutfit = stylist.checkOutfit;
export import isEligible = stylist.isEligible;
export import isModestCompliant = stylist.isModestCompliant;
export import optimizeOutfits = stylist.optimizeOutfits;
export import planCapsule = stylist.planCapsule;
export import rulesOutfits = stylist.rulesOutfits;
export import unaryValue = stylist.unaryValue;
export import updateStyleVector = stylist.updateStyleVector;
export type Candidate = stylist.Candidate;
export type FeedbackSignal = stylist.FeedbackSignal;
export type MissingSlot = stylist.MissingSlot;
export type Outfit = stylist.Outfit;
export type OutfitRequest = stylist.OutfitRequest;
export type OutfitSource = stylist.OutfitSource;
export type Season = stylist.Season;
export type Slot = stylist.Slot;
