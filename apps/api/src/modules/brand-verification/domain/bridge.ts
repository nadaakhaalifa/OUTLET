/** Single seam to the pure brand-verification domain (@outlet/domain namespace `brandVerification`). Aliases only. */
import { brandVerification as bv } from "@outlet/domain";

export type BrandKind = bv.BrandKind;
export type AutoCheck = bv.AutoCheck;
export type AutoCheckReport = bv.AutoCheckReport;
export type CheckResult = bv.CheckResult;
export type ClaimView = bv.ClaimView;
export type ConflictFinding = bv.ConflictFinding;
export type ConflictOutcome = bv.ConflictOutcome;
export type ConflictReason = bv.ConflictReason;
export type EmailLocalPart = bv.EmailLocalPart;
export type OwnerMatchBand = bv.OwnerMatchBand;
export type RiskBand = bv.RiskBand;
export type DomainRejection = bv.DomainRejection;

export import CONFLICT_OUTCOMES = bv.CONFLICT_OUTCOMES;
export import DNS_CHALLENGE_TTL_MS = bv.DNS_CHALLENGE_TTL_MS;
export import EMAIL_CHALLENGE_TTL_MS = bv.EMAIL_CHALLENGE_TTL_MS;
export import EMAIL_LOCAL_PARTS = bv.EMAIL_LOCAL_PARTS;
export import aggregateAutoChecks = bv.aggregateAutoChecks;
export import claimNameNorm = bv.claimNameNorm;
export import compareOwner = bv.compareOwner;
export import detectClaimConflicts = bv.detectClaimConflicts;
export import dnsChallengeToken = bv.dnsChallengeToken;
export import emailAddressFor = bv.emailAddressFor;
export import emailDomainMatches = bv.emailDomainMatches;
export import evaluateCountry = bv.evaluateCountry;
export import evaluateEmailAttempt = bv.evaluateEmailAttempt;
export import maskEmail = bv.maskEmail;
export import orderByPriority = bv.orderByPriority;
export import trademarkKeyOf = bv.trademarkKeyOf;
export import txtContainsValue = bv.txtContainsValue;
export import txtRecordName = bv.txtRecordName;
export import txtRecordValue = bv.txtRecordValue;
export import validateBrandDomain = bv.validateBrandDomain;
