/**
 * Country and requirements policy (ADR-0031). Pure data plus decision functions; the lists are
 * CONFIG DEFAULTS that admins edit with audit and dual approval (spec 'Admin config').
 * Every list below is HAND-AUTHORED by engineering and is VERIFY BEFORE LAUNCH (ADR-0031 open items:
 * sanctions list source, high-risk country list). They are not legal determinations.
 */
import { isKnownCountry } from "./countries";

export type BrandKind = "local" | "global";

export const DEFAULT_LOCAL_COUNTRY = "EG";

/** Applicants from these countries can start an application but cannot submit (422 country_not_supported). */
export const DEFAULT_BLOCKED_COUNTRIES: readonly string[] = ["KP", "IR", "SY", "CU"];

/**
 * Countries whose GLOBAL brands need a second approver (dual approval). Placeholder modelled on
 * public AML watch-list categories; VERIFY BEFORE LAUNCH against the compliance-owned source.
 */
export const HIGH_RISK_COUNTRIES: readonly string[] = ["AF", "KP", "IR", "MM", "SY", "YE", "SO", "LY", "SS", "VE", "HT", "CD"];

export interface CountryPolicy {
  /** `null` means every ISO country except the blocked ones. */
  readonly allowedCountries: readonly string[] | null;
  readonly blockedCountries: readonly string[];
  readonly highRiskCountries: readonly string[];
}

export const DEFAULT_COUNTRY_POLICY: CountryPolicy = {
  allowedCountries: null,
  blockedCountries: DEFAULT_BLOCKED_COUNTRIES,
  highRiskCountries: HIGH_RISK_COUNTRIES,
};

export type CountryDecision = "allowed" | "unknown_country" | "blocked" | "not_in_allow_list" | "local_must_be_egypt";

export function evaluateCountry(kind: BrandKind, country: string, policy: CountryPolicy = DEFAULT_COUNTRY_POLICY): CountryDecision {
  const code = country.toUpperCase();
  if (!isKnownCountry(code)) return "unknown_country";
  if (kind === "local" && code !== DEFAULT_LOCAL_COUNTRY) return "local_must_be_egypt";
  if (policy.blockedCountries.includes(code)) return "blocked";
  if (policy.allowedCountries !== null && !policy.allowedCountries.includes(code)) return "not_in_allow_list";
  return "allowed";
}

export const isHighRiskCountry = (country: string, policy: CountryPolicy = DEFAULT_COUNTRY_POLICY): boolean =>
  policy.highRiskCountries.includes(country.toUpperCase());

export type SanctionsOutcome = "clear" | "warn" | "fail" | "error" | "not_run";

/** Spec 'Reviewer integrity': GLOBAL and (high-risk country or sanctions warn/fail) needs a cosigner. */
export function requiresDualApproval(
  input: { readonly kind: BrandKind; readonly country: string; readonly sanctions: SanctionsOutcome },
  policy: CountryPolicy = DEFAULT_COUNTRY_POLICY,
): boolean {
  if (input.kind !== "global") return false;
  return isHighRiskCountry(input.country, policy) || input.sanctions === "warn" || input.sanctions === "fail";
}
