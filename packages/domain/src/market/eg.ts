import { defineMarket } from "./market";

/**
 * The only market defined and enabled. Values restate what the system already assumed (EGP piastres,
 * Africa/Cairo, Arabic default). Refs are keys; the data behind them lives in the owning modules.
 * ADR-0002 (data residency) is Proposed, so the residency key is a placeholder label, not a decision.
 */
export const EG_MARKET = defineMarket({
  code: "EG",
  currency: { code: "EGP", minorUnitExponent: 2 },
  defaultLocale: "ar-EG",
  supportedLocales: ["ar-EG", "en"],
  timezone: "Africa/Cairo",
  vatConfigRef: "vat:eg:default",
  agePolicyRef: "age-policy:eg:default",
  paymentMethods: ["card", "apple_pay", "mobile_wallet", "instapay", "fawry", "cod", "bnpl"],
  couriers: ["bosta", "aramex", "mylerz"],
  legalTextSetKey: "legal:eg:v1",
  dataResidencyRegionKey: "residency:pending-adr-0002",
});
