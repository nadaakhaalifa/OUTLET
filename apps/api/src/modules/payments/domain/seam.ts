/**
 * Single seam to the pure payments domain (`@outlet/domain` namespace `payments`, source in
 * packages/domain/src/payments). Aliases only; no behaviour.
 */
import { payments } from "@outlet/domain";

export type AnomalyKind = payments.AnomalyKind;
export type BreakerConfig = payments.BreakerConfig;
export type BreakerState = payments.BreakerState;
export type BreakerStates = payments.BreakerStates;
export type EffectDecision = payments.EffectDecision;
export type IntentView = payments.IntentView;
export type KillSwitchFamily = payments.KillSwitchFamily;
export type MethodUnavailableReason = payments.MethodUnavailableReason;
export type NormalizedPaymentEvent = payments.NormalizedPaymentEvent;
export type NormalizedEventKind = payments.NormalizedEventKind;
export type PaymentDomainEvent = payments.PaymentDomainEvent;
export type PaymentIntentEvent = payments.PaymentIntentEvent;
export type PaymentIntentStatus = payments.PaymentIntentStatus;
export type PaymentMethodId = payments.PaymentMethodId;
export type PaymentMethodMeta = payments.PaymentMethodMeta;
export type ProviderId = payments.ProviderId;
export type RefundDecision = payments.RefundDecision;
export type RoutePolicy = payments.RoutePolicy;
export import CLOSED = payments.CLOSED;
export import DEFAULT_BREAKER_CONFIG = payments.DEFAULT_BREAKER_CONFIG;
export import NORMALIZED_EVENT_KINDS = payments.NORMALIZED_EVENT_KINDS;
export import PAYMENT_CURRENCY = payments.PAYMENT_CURRENCY;
export import PAYMENT_INTENT_STATES = payments.PAYMENT_INTENT_STATES;
export import PAYMENT_METHOD_IDS = payments.PAYMENT_METHOD_IDS;
export import PAYMENT_METHOD_META = payments.PAYMENT_METHOD_META;
export import WEBHOOK_TOLERANCE_MS = payments.WEBHOOK_TOLERANCE_MS;
export import admit = payments.admit;
export import decideRefundApplication = payments.decideRefundApplication;
export import decideWebhookEffect = payments.decideWebhookEffect;
export import isPaymentMethodId = payments.isPaymentMethodId;
export import isProviderId = payments.isProviderId;
export import onFailure = payments.onFailure;
export import onSuccess = payments.onSuccess;
export import paymentIntentMachine = payments.paymentIntentMachine;
export import providerOrder = payments.providerOrder;
export import selectProvider = payments.selectProvider;
export import validateBreakerConfig = payments.validateBreakerConfig;
export import withinTolerance = payments.withinTolerance;
export import wouldAdmit = payments.wouldAdmit;
