import { z } from "zod";
import type { sellers } from "@outlet/domain";
import type { ApplicationRow, DocumentRow, FieldCipherPort } from "../domain/ports";

/** The encrypted blob. Everything personal about the applicant and signatory except the national id. */
export const PiiSchema = z
  .object({
    legalName: z.string().optional(),
    contactName: z.string().optional(),
    contactPhone: z.string().optional(),
    contactEmail: z.string().optional(),
    signatoryFullName: z.string().optional(),
    signatoryDob: z.string().optional(),
  })
  .strict();
export type Pii = z.infer<typeof PiiSchema>;

export interface ApplicationView {
  readonly row: ApplicationRow;
  readonly documents: readonly DocumentRow[];
  readonly pii: Pii;
  readonly nationalId: string | null;
  readonly filenames: ReadonlyMap<string, string | null>;
}

export const piiAad = (id: string): string => `brand_application:${id}:pii`;
export const nationalIdAad = (id: string): string => `brand_application:${id}:national_id`;
export const filenameAad = (docId: string): string => `brand_document:${docId}:filename`;

export async function encryptPii(cipher: FieldCipherPort, id: string, pii: Pii): Promise<Uint8Array | null> {
  const clean = Object.fromEntries(Object.entries(pii).filter(([, v]) => v !== undefined && v !== ""));
  return Object.keys(clean).length === 0 ? null : cipher.encrypt(JSON.stringify(clean), piiAad(id));
}

export async function decodeView(cipher: FieldCipherPort, row: ApplicationRow, documents: readonly DocumentRow[]): Promise<ApplicationView> {
  const pii: Pii = row.piiEnc === null ? {} : PiiSchema.parse(JSON.parse(await cipher.decrypt(row.piiEnc, piiAad(row.id))));
  const nationalId = row.nationalIdEnc === null ? null : await cipher.decrypt(row.nationalIdEnc, nationalIdAad(row.id));
  const filenames = new Map<string, string | null>();
  for (const d of documents) {
    filenames.set(d.id, d.originalFilenameEnc === null ? null : await cipher.decrypt(d.originalFilenameEnc, filenameAad(d.id)));
  }
  return { row, documents, pii, nationalId, filenames };
}

/** Flat field map keyed by requirement code, the shape the pure completeness rules read. */
export function flatFields(v: ApplicationView): Record<string, string | undefined> {
  const r = v.row;
  const out: Record<string, string | undefined> = {
    brand_name: r.brandName,
    legal_name: v.pii.legalName,
    ownership_basis: r.ownershipBasis ?? undefined,
    contact_name: v.pii.contactName,
    contact_phone: v.pii.contactPhone,
    contact_email: v.pii.contactEmail,
    signatory_full_name: v.pii.signatoryFullName,
    signatory_national_id: v.nationalId ?? undefined,
    signatory_dob: v.pii.signatoryDob,
    commercial_register_no: r.commercialRegisterNo ?? undefined,
    tax_card_no: r.taxCardNo ?? undefined,
    company_reg_no: r.companyRegNo ?? undefined,
    company_reg_country: r.companyRegCountry ?? undefined,
    vat_or_tax_id: r.vatOrTaxId ?? undefined,
    trademark_number: r.trademarkNumber ?? undefined,
    website_domain: r.websiteDomain ?? undefined,
    eta_registration: r.etaRegistration ?? undefined,
  };
  return out;
}

export const acknowledgementsAccepted = (r: ApplicationRow): boolean =>
  typeof r.acknowledgements["seller_agreement_version"] === "string" &&
  typeof r.acknowledgements["dpa_version"] === "string" &&
  r.acknowledgements["price_monitoring_consent"] === true;

export const documentFacts = (docs: readonly DocumentRow[]): sellers.DocumentFacts[] =>
  docs.map((d) => ({ requirementCode: d.requirementCode, uploadStatus: d.uploadStatus, scanStatus: d.scanStatus, reviewStatus: d.reviewStatus }));
