import type { FieldFormat } from "./validators";
import type { BrandKind } from "./types";

/** Requirements as data (wire shape of BrandRequirements). Admin-editable table later; pure defaults here. */
export interface RequirementField {
  readonly code: string;
  readonly label_ar: string;
  readonly label_en: string;
  readonly required: boolean;
  readonly format: FieldFormat;
  readonly pattern?: string;
  readonly min_signatory_age?: number;
}

export interface RequirementDocument {
  readonly code: string;
  readonly label_ar: string;
  readonly label_en: string;
  readonly required: boolean;
  readonly one_of_group?: string;
  readonly accepts: readonly ("pdf" | "jpg" | "png")[];
  readonly max_bytes: number;
  readonly help_ar?: string;
  readonly help_en?: string;
}

export interface BrandRequirements {
  readonly kind: BrandKind;
  readonly country: string;
  readonly version: number;
  readonly fields: readonly RequirementField[];
  readonly documents: readonly RequirementDocument[];
  readonly website_verification: "required_if_website" | "required" | "optional";
  readonly eta_registration_asked: boolean;
}

export const REQUIREMENTS_VERSION = 1;
const TEN_MB = 10 * 1024 * 1024;
const ACCEPTS = ["pdf", "jpg", "png"] as const;

const f = (
  code: string,
  ar: string,
  en: string,
  required: boolean,
  format: FieldFormat,
  extra: Partial<RequirementField> = {},
): RequirementField => ({ code, label_ar: ar, label_en: en, required, format, ...extra });
const d = (
  code: string,
  ar: string,
  en: string,
  required: boolean,
  group?: string,
): RequirementDocument => ({
  code,
  label_ar: ar,
  label_en: en,
  required,
  ...(group !== undefined ? { one_of_group: group } : {}),
  accepts: ACCEPTS,
  max_bytes: TEN_MB,
});

const COMMON_FIELDS: readonly RequirementField[] = [
  f("brand_name", "اسم العلامة التجارية", "Brand name", true, "text"),
  f("legal_name", "الاسم القانوني", "Legal name", true, "text"),
  f("ownership_basis", "أساس الملكية", "Ownership basis", true, "text"),
  f("contact_name", "اسم جهة الاتصال", "Contact name", true, "text"),
  f("contact_phone", "هاتف جهة الاتصال", "Contact phone", true, "phone"),
  f("contact_email", "بريد جهة الاتصال", "Contact email", true, "email"),
  f("signatory_full_name", "اسم المفوض بالتوقيع", "Authorised signatory name", true, "text"),
  f("signatory_national_id", "الرقم القومي للمفوض", "Signatory national ID", true, "national_id", { min_signatory_age: 21 }),
  f("signatory_dob", "تاريخ ميلاد المفوض", "Signatory date of birth", true, "date", { min_signatory_age: 21 }),
];

const EG_LOCAL: BrandRequirements = {
  kind: "local",
  country: "EG",
  version: REQUIREMENTS_VERSION,
  fields: [
    ...COMMON_FIELDS,
    f("commercial_register_no", "رقم السجل التجاري", "Commercial register number", true, "commercial_register_no"),
    f("tax_card_no", "رقم البطاقة الضريبية", "Tax card number", true, "tax_card_no"),
    f("website_domain", "نطاق الموقع", "Website domain", false, "domain"),
    f("trademark_number", "رقم تسجيل العلامة", "Trademark registration number", false, "text"),
  ],
  documents: [
    d("commercial_register", "السجل التجاري", "Commercial register", true),
    d("tax_card", "البطاقة الضريبية", "Tax card", true),
    d("signatory_id", "بطاقة المفوض بالتوقيع", "Signatory national ID", true),
    d("trademark_certificate", "شهادة تسجيل العلامة", "Trademark certificate", true, "ownership_proof"),
    d("brand_authorization", "تفويض من مالك العلامة", "Brand authorization", true, "ownership_proof"),
    d("proof_of_purchase", "إثبات الشراء", "Proof of purchase", true, "ownership_proof"),
  ],
  website_verification: "required_if_website",
  eta_registration_asked: true,
};

const GLOBAL_DEFAULT: BrandRequirements = {
  kind: "global",
  country: "*",
  version: REQUIREMENTS_VERSION,
  fields: [
    ...COMMON_FIELDS,
    f("company_reg_no", "رقم تسجيل الشركة", "Company registration number", true, "company_reg_no"),
    f("company_reg_country", "دولة تسجيل الشركة", "Company registration country", true, "country"),
    f("vat_or_tax_id", "الرقم الضريبي", "VAT or tax ID", false, "vat_id"),
    f("trademark_number", "رقم تسجيل العلامة", "Trademark registration number", false, "text"),
    f("website_domain", "نطاق الموقع", "Website domain", true, "domain"),
  ],
  documents: [
    d("company_registration_extract", "مستخرج تسجيل الشركة", "Company registration extract", true),
    d("signatory_id", "هوية المفوض بالتوقيع", "Authorised signatory ID", true),
    d("trademark_certificate", "شهادة تسجيل العلامة", "Trademark registration", true, "ownership_proof"),
    d("distributor_letter", "خطاب توزيع معتمد", "Distributor authorization letter", true, "ownership_proof"),
  ],
  website_verification: "required",
  eta_registration_asked: false,
};

/** Falls back to the global default for unknown countries; local brands are Egypt-only for now. */
export function getRequirements(kind: BrandKind, country: string): BrandRequirements {
  if (kind === "local") return { ...EG_LOCAL, country };
  return { ...GLOBAL_DEFAULT, country };
}

/** Required document requirement groups: each plain required doc, and each one_of_group once. */
export function requiredDocumentGroups(req: BrandRequirements): readonly (readonly string[])[] {
  const groups = new Map<string, string[]>();
  const out: string[][] = [];
  for (const doc of req.documents) {
    if (!doc.required) continue;
    if (doc.one_of_group === undefined) out.push([doc.code]);
    else {
      const g = groups.get(doc.one_of_group);
      if (g === undefined) {
        const n = [doc.code];
        groups.set(doc.one_of_group, n);
        out.push(n);
      } else g.push(doc.code);
    }
  }
  return out;
}
