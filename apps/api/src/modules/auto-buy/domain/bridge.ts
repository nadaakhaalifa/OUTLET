/**
 * Single seam to the pure auto-buy domain (`@outlet/domain` namespace `autoBuy`, source in
 * packages/domain/src/auto-buy). Aliases only; no behaviour.
 */
import { autoBuy } from "@outlet/domain";

export type AutoBuyMode = autoBuy.AutoBuyMode;
export type MandateStatus = autoBuy.MandateStatus;
export type AttemptState = autoBuy.AttemptState;
export type ChargeDecision = autoBuy.ChargeDecision;
export type ChargeFacts = autoBuy.ChargeFacts;
export type ChargeSkipReason = autoBuy.ChargeSkipReason;
export type BudgetDecision = autoBuy.BudgetDecision;
export type RiskDecision = autoBuy.RiskDecision;
export type TokenState = autoBuy.TokenState;
export type MandateLocale = autoBuy.MandateLocale;
export type TermsViolation = autoBuy.TermsViolation;
export type TriggerDecision = autoBuy.TriggerDecision;
export type PriceSignal = autoBuy.PriceSignal;
export type MandateView = autoBuy.MandateView;

export import AUTO_BUY_LIMITS = autoBuy.AUTO_BUY_LIMITS;
export import AUTO_BUY_MODES = autoBuy.AUTO_BUY_MODES;
export import MANDATE_LOCALES = autoBuy.MANDATE_LOCALES;
export import CURRENT_MANDATE_VERSION = autoBuy.CURRENT_MANDATE_VERSION;
export import OPEN_ATTEMPT_STATES = autoBuy.OPEN_ATTEMPT_STATES;
export import canCancelAttempt = autoBuy.canCancelAttempt;
export import decideCharge = autoBuy.decideCharge;
export import evaluateTrigger = autoBuy.evaluateTrigger;
export import formatPiastres = autoBuy.formatPiastres;
export import idempotencyKeyFor = autoBuy.idempotencyKeyFor;
export import isAttemptState = autoBuy.isAttemptState;
export import mandateTemplate = autoBuy.mandateTemplate;
export import nextAttemptState = autoBuy.nextAttemptState;
export import renderMandateText = autoBuy.renderMandateText;
export import reservationTtlMs = autoBuy.reservationTtlMs;
export import validateMandateTerms = autoBuy.validateMandateTerms;
