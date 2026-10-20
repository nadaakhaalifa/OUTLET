/**
 * Single seam to the pure resale domain (packages/domain/src/resale). Aliases and re-exports only,
 * no behaviour (ADR-0018).
 */
import { resale } from "@outlet/domain";
export import GRADES = resale.GRADES;
export import GRADE_LABELS = resale.GRADE_LABELS;
export import RESALE_CONDITION = resale.RESALE_CONDITION;
export import InvalidListingTransitionError = resale.InvalidListingTransitionError;
export import allocateResaleProceeds = resale.allocateResaleProceeds;
export import checkResaleEligibility = resale.checkResaleEligibility;
export import isGrade = resale.isGrade;
export import makesNoDiscountClaim = resale.makesNoDiscountClaim;
export import moveListing = resale.moveListing;
export import resalePriceDisplay = resale.resalePriceDisplay;
export import validateListing = resale.validateListing;
export type Grade = resale.Grade;
export type ListingStatus = resale.ListingStatus;
export type Ownership = resale.Ownership;
export type Proceeds = resale.Proceeds;
export type ProceedsTerms = resale.ProceedsTerms;
export type ResaleReturnClass = resale.ResaleReturnClass;
export type ResaleRefusal = resale.ResaleRefusal;
export type ListingIssue = resale.ListingIssue;
