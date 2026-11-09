import type { MessageKey } from "@outlet/i18n";

/** Pure rules of the Seller Center application form (the server stays the authority; these only save a round trip). */

export const KYC_STATES = ["DRAFT", "SUBMITTED", "AUTO_CHECKS", "APPROVED", "NEEDS_INFO", "REJECTED", "SUSPENDED"] as const;
export type KycState = (typeof KYC_STATES)[number];
/** The linear review track shown to the seller; NEEDS_INFO, REJECTED and SUSPENDED are exits from it. */
export const KYC_TRACK = ["DRAFT", "SUBMITTED", "AUTO_CHECKS", "APPROVED"] as const;

export const DOC_TYPES = ["commercial_register", "tax_card", "signatory_national_id", "iban_letter", "brand_authorization", "proof_of_purchase"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const SIGNATORY_MIN_AGE = 21;
export const MAX_DOCUMENT_MB = 10;
export const MAX_DOCUMENT_BYTES = MAX_DOCUMENT_MB * 1024 * 1024;

/** Egypt's 27 governorates: stable code (sent to the API) and the message key of the display name. */
export const GOVERNORATES = [
  "cairo", "giza", "alexandria", "qalyubia", "port_said", "suez", "damietta", "dakahlia", "sharqia", "gharbia", "monufia", "kafr_el_sheikh", "beheira",
  "ismailia", "fayoum", "beni_suef", "minya", "assiut", "sohag", "qena", "luxor", "aswan", "red_sea", "new_valley", "matrouh", "north_sinai", "south_sinai",
] as const;
export type GovernorateCode = (typeof GOVERNORATES)[number];
export const governorateKey = (code: GovernorateCode): MessageKey => `seller.kyc.gov.${code}`;

export interface IdentityForm {
  readonly legalType: "company" | "sole_trader";
  readonly nameAr: string;
  readonly nameEn: string;
  readonly register: string;
  readonly tax: string;
  readonly governorate: "" | GovernorateCode;
  readonly signatoryOk: boolean;
}
export const EMPTY_IDENTITY: IdentityForm = { legalType: "company", nameAr: "", nameEn: "", register: "", tax: "", governorate: "", signatoryOk: false };

export type IdentityProblem = "nameAr" | "register" | "tax" | "governorate" | "signatory";
export const identityProblems = (f: IdentityForm): IdentityProblem[] => {
  const out: IdentityProblem[] = [];
  if (f.nameAr.trim() === "") out.push("nameAr");
  if (f.register.trim() === "") out.push("register");
  if (f.tax.trim() === "") out.push("tax");
  if (f.governorate === "") out.push("governorate");
  if (!f.signatoryOk) out.push("signatory");
  return out;
};

/** ISO 13616 mod-97 check (letters map to 10..35). */
export const ibanValid = (raw: string): boolean => {
  const iban = raw.replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  let rem = 0;
  for (const ch of `${iban.slice(4)}${iban.slice(0, 4)}`) {
    const v = ch >= "A" ? ch.charCodeAt(0) - 55 : Number(ch);
    rem = v > 9 ? (rem * 100 + v) % 97 : (rem * 10 + v) % 97;
  }
  return rem === 1;
};
export const normalizeIban = (raw: string): string => raw.replace(/\s+/g, "").toUpperCase();

export const validDocumentFile = (f: { readonly type: string; readonly size: number }): "type" | "size" | null =>
  f.type !== "application/pdf" ? "type" : f.size > MAX_DOCUMENT_BYTES || f.size === 0 ? "size" : null;

const GAP_KEYS: Readonly<Record<string, MessageKey>> = {
  bank_account: "seller.kyc.gap.bank_account",
  legal_name_ar: "seller.kyc.gap.legal_name_ar",
  commercial_register_no: "seller.kyc.gap.commercial_register_no",
  tax_card_no: "seller.kyc.gap.tax_card_no",
  governorate_name_ar: "seller.kyc.gap.governorate_name_ar",
  legal_identity: "seller.kyc.gap.legal_identity",
};
const DOC_KEYS: Readonly<Record<DocType, MessageKey>> = {
  commercial_register: "seller.kyc.doc.commercial_register",
  tax_card: "seller.kyc.doc.tax_card",
  signatory_national_id: "seller.kyc.doc.signatory_national_id",
  iban_letter: "seller.kyc.doc.iban_letter",
  brand_authorization: "seller.kyc.doc.brand_authorization",
  proof_of_purchase: "seller.kyc.doc.proof_of_purchase",
};
export const docKey = (d: DocType): MessageKey => DOC_KEYS[d];

/** A gap code from the API as a copy key plus the document it concerns (so the UI can name it). */
export const gapKey = (code: string): { readonly key: MessageKey; readonly doc?: DocType } => {
  if (code.startsWith("document:")) {
    const d = DOC_TYPES.find((x) => x === code.slice("document:".length));
    return d === undefined ? { key: "seller.kyc.gap.unknown" } : { key: "seller.kyc.gap.document", doc: d };
  }
  return { key: GAP_KEYS[code] ?? "seller.kyc.gap.unknown" };
};
export const documentPresent = (gaps: readonly string[], d: DocType): boolean => !gaps.includes(`document:${d}`);

export const STATE_KEYS: Readonly<Record<KycState, { readonly label: MessageKey; readonly desc: MessageKey }>> = {
  DRAFT: { label: "seller.kyc.state.DRAFT", desc: "seller.kyc.state.DRAFT.desc" },
  SUBMITTED: { label: "seller.kyc.state.SUBMITTED", desc: "seller.kyc.state.SUBMITTED.desc" },
  AUTO_CHECKS: { label: "seller.kyc.state.AUTO_CHECKS", desc: "seller.kyc.state.AUTO_CHECKS.desc" },
  APPROVED: { label: "seller.kyc.state.APPROVED", desc: "seller.kyc.state.APPROVED.desc" },
  NEEDS_INFO: { label: "seller.kyc.state.NEEDS_INFO", desc: "seller.kyc.state.NEEDS_INFO.desc" },
  REJECTED: { label: "seller.kyc.state.REJECTED", desc: "seller.kyc.state.REJECTED.desc" },
  SUSPENDED: { label: "seller.kyc.state.SUSPENDED", desc: "seller.kyc.state.SUSPENDED.desc" },
};
/** The seller may still edit documents and the bank account only while the case is open for input. */
export const editable = (s: KycState): boolean => s === "DRAFT" || s === "NEEDS_INFO";
