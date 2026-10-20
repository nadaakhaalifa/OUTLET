/**
 * Maps between the form's flat field codes (from the requirements data) and the wire's nested application record.
 * Unknown field codes are kept locally and not sent (the server rejects unknown keys; the gap is noted in the design doc).
 */
import type { ApplicationPatch } from "./model";

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

/** [group, key] on the wire; group "" means a top-level key. */
const MAP: Readonly<Record<string, readonly [string, string]>> = {
  legal_name: ["", "legal_name"],
  commercial_register_no: ["registration", "commercial_register_no"],
  tax_card_no: ["registration", "tax_card_no"],
  company_reg_no: ["registration", "company_reg_no"],
  company_reg_country: ["registration", "company_reg_country"],
  vat_or_tax_id: ["registration", "vat_or_tax_id"],
  website_domain: ["", "website_domain"],
  eta_registration: ["", "eta_registration"],
  instagram: ["social_handles", "instagram"],
  tiktok: ["social_handles", "tiktok"],
  facebook: ["social_handles", "facebook"],
  contact_name: ["contact", "name"],
  contact_phone: ["contact", "phone_e164"],
  contact_email: ["contact", "email"],
  signatory_full_name: ["signatory", "full_name"],
  signatory_national_id: ["signatory", "national_id"],
  signatory_date_of_birth: ["signatory", "date_of_birth"],
  trademark_register: ["trademark", "register"],
  trademark_number: ["trademark", "number"],
  trademark_owner_name: ["trademark", "owner_name"],
};

export const isSendable = (code: string): boolean => code in MAP;

export function toWirePatch(patch: ApplicationPatch): Rec {
  const out: Rec = {};
  if (patch.brandName !== undefined) out["brand_name"] = patch.brandName;
  if (patch.ownershipBasis !== undefined) out["ownership_basis"] = patch.ownershipBasis;
  for (const [code, value] of Object.entries(patch.values ?? {})) {
    const m = MAP[code];
    if (m === undefined || value === "") continue;
    const [group, key] = m;
    if (group === "") out[key] = value;
    else {
      const g = isRec(out[group]) ? out[group] : {};
      g[key] = value;
      out[group] = g;
    }
  }
  return out;
}

/** Flat values from a wire application. National ID and DOB are never returned by the server: they stay local. */
export function fromWireValues(app: Rec): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [code, [group, key]] of Object.entries(MAP)) {
    const src = group === "" ? app : app[group === "signatory" ? "signatory_masked" : group];
    const v = isRec(src) ? str(src[key]) : group === "" ? str(app[key]) : undefined;
    if (v !== undefined) out[code] = v;
  }
  return out;
}
