import { sellers } from "@outlet/domain";
import type { Application, ApplicationDocument, ApplicationPatch, FieldFormat, Requirements } from "../api/schemas-onboarding";
import type { Locale, MessageKey } from "../i18n";
import { foldDigits, normalizePhone, toAsciiDigits } from "./auth-flow";

/**
 * Brand application form, generated from the requirements data (no field list is hard-coded in the UI).
 * Pure: no React, no network. The server re-validates everything; this gives early, accessible errors.
 */

/** Draft legal-text versions stamped on acknowledgements. Counsel must confirm before launch (verify register). */
export const SELLER_AGREEMENT_VERSION = "draft-2026-10";
export const DPA_VERSION = "draft-2026-10";

export type FieldSection = "brand" | "registration" | "contact" | "signatory";
export type InputKind = "text" | "tel" | "email" | "date" | "select";

export interface FieldModel {
  readonly code: string;
  readonly label: string;
  readonly required: boolean;
  readonly format: FieldFormat;
  readonly section: FieldSection;
  readonly input: InputKind;
  readonly inputMode: "text" | "numeric" | "tel" | "email";
  readonly dir: "ltr" | "auto";
  readonly autoComplete: string;
  readonly maxLength: number;
  /** Where the value goes in PATCH /v1/seller/applications/{id}. */
  readonly path: readonly [string] | readonly [string, string];
  readonly options: readonly { readonly value: string; readonly labelKey: MessageKey }[];
  /** Sensitive identity fields come back masked and are never prefilled. */
  readonly writeOnly: boolean;
  readonly pattern: string | null;
  readonly minSignatoryAge: number | null;
}

interface Meta {
  readonly path: readonly [string] | readonly [string, string];
  readonly section: FieldSection;
  readonly input?: InputKind;
  readonly writeOnly?: boolean;
}

const OWNERSHIP: FieldModel["options"] = [
  { value: "brand_owner", labelKey: "ob.owner.brand_owner" },
  { value: "authorized_distributor", labelKey: "ob.owner.authorized_distributor" },
  { value: "third_party_reseller", labelKey: "ob.owner.third_party_reseller" },
];

const META: Readonly<Record<string, Meta>> = {
  brand_name: { path: ["brand_name"], section: "brand" },
  legal_name: { path: ["legal_name"], section: "brand" },
  ownership_basis: { path: ["ownership_basis"], section: "brand", input: "select" },
  website_domain: { path: ["website_domain"], section: "brand" },
  trademark_number: { path: ["trademark", "number"], section: "brand" },
  commercial_register_no: { path: ["registration", "commercial_register_no"], section: "registration" },
  tax_card_no: { path: ["registration", "tax_card_no"], section: "registration" },
  company_reg_no: { path: ["registration", "company_reg_no"], section: "registration" },
  company_reg_country: { path: ["registration", "company_reg_country"], section: "registration" },
  vat_or_tax_id: { path: ["registration", "vat_or_tax_id"], section: "registration" },
  contact_name: { path: ["contact", "name"], section: "contact" },
  contact_phone: { path: ["contact", "phone_e164"], section: "contact" },
  contact_email: { path: ["contact", "email"], section: "contact" },
  signatory_full_name: { path: ["signatory", "full_name"], section: "signatory", writeOnly: true },
  signatory_national_id: { path: ["signatory", "national_id"], section: "signatory", writeOnly: true },
  signatory_dob: { path: ["signatory", "date_of_birth"], section: "signatory", writeOnly: true },
};

const INPUT_BY_FORMAT: Readonly<Record<FieldFormat, { input: InputKind; inputMode: FieldModel["inputMode"]; dir: FieldModel["dir"]; autoComplete: string; maxLength: number }>> = {
  text: { input: "text", inputMode: "text", dir: "auto", autoComplete: "off", maxLength: 500 },
  national_id: { input: "text", inputMode: "numeric", dir: "ltr", autoComplete: "off", maxLength: 30 },
  commercial_register_no: { input: "text", inputMode: "text", dir: "ltr", autoComplete: "off", maxLength: 20 },
  tax_card_no: { input: "text", inputMode: "numeric", dir: "ltr", autoComplete: "off", maxLength: 16 },
  company_reg_no: { input: "text", inputMode: "text", dir: "ltr", autoComplete: "off", maxLength: 40 },
  vat_id: { input: "text", inputMode: "text", dir: "ltr", autoComplete: "off", maxLength: 25 },
  url: { input: "text", inputMode: "text", dir: "ltr", autoComplete: "url", maxLength: 253 },
  domain: { input: "text", inputMode: "text", dir: "ltr", autoComplete: "off", maxLength: 253 },
  handle: { input: "text", inputMode: "text", dir: "ltr", autoComplete: "off", maxLength: 60 },
  phone: { input: "tel", inputMode: "tel", dir: "ltr", autoComplete: "tel", maxLength: 20 },
  email: { input: "email", inputMode: "email", dir: "ltr", autoComplete: "email", maxLength: 254 },
  country: { input: "text", inputMode: "text", dir: "ltr", autoComplete: "off", maxLength: 2 },
  date: { input: "date", inputMode: "text", dir: "ltr", autoComplete: "off", maxLength: 10 },
};

export interface FormModel {
  readonly fields: readonly FieldModel[];
  /** Requirement codes this build cannot map to an API field; surfaced instead of silently dropped. */
  readonly unmapped: readonly string[];
}

export function buildFormModel(req: Requirements, locale: Locale): FormModel {
  const fields: FieldModel[] = [];
  const unmapped: string[] = [];
  for (const f of req.fields) {
    const meta = META[f.code];
    if (meta === undefined) {
      unmapped.push(f.code);
      continue;
    }
    const base = INPUT_BY_FORMAT[f.format];
    const input = meta.input ?? base.input;
    fields.push({
      code: f.code,
      label: locale === "ar" ? f.label_ar : f.label_en,
      required: f.required,
      format: f.format,
      section: meta.section,
      input,
      inputMode: base.inputMode,
      dir: base.dir,
      autoComplete: base.autoComplete,
      maxLength: base.maxLength,
      path: meta.path,
      options: input === "select" ? OWNERSHIP : [],
      writeOnly: meta.writeOnly === true,
      pattern: f.pattern ?? null,
      minSignatoryAge: f.min_signatory_age ?? null,
    });
  }
  return { fields, unmapped };
}

export const SECTION_ORDER: readonly FieldSection[] = ["brand", "registration", "contact", "signatory"];
export const SECTION_KEY: Readonly<Record<FieldSection, MessageKey>> = {
  brand: "ob.section.brand",
  registration: "ob.section.registration",
  contact: "ob.section.contact",
  signatory: "ob.section.signatory",
};

export function fieldsBySection(model: FormModel): readonly { readonly section: FieldSection; readonly fields: readonly FieldModel[] }[] {
  return SECTION_ORDER.map((section) => ({ section, fields: model.fields.filter((f) => f.section === section) })).filter((s) => s.fields.length > 0);
}

/* ---------------- values ---------------- */
export type FormValues = Readonly<Record<string, string>>;

const asString = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Readonly<Record<string, unknown>> => (typeof v === "object" && v !== null ? (v as Readonly<Record<string, unknown>>) : {});

/** Values already stored on the application (write-only identity fields stay blank). */
export function initialValues(app: Application | null, model: FormModel): FormValues {
  const out: Record<string, string> = {};
  if (app === null) return out;
  const source: Record<string, unknown> = {
    brand_name: app.brand_name,
    legal_name: app.legal_name,
    ownership_basis: app.ownership_basis,
    website_domain: app.website_domain,
    registration: app.registration,
    trademark: app.trademark,
    contact: app.contact,
  };
  for (const f of model.fields) {
    if (f.writeOnly) continue;
    const [a, b] = f.path;
    out[f.code] = b === undefined ? asString(source[a]) : asString(obj(source[a])[b]);
  }
  return out;
}

/** Which write-only identity fields the server already holds (masked), so edits may leave them blank. */
export function providedWriteOnly(app: Application | null): ReadonlySet<string> {
  const m = obj(app?.signatory_masked);
  const out = new Set<string>();
  if (asString(m.full_name) !== "" || m.full_name_provided === true) out.add("signatory_full_name");
  if (asString(m.national_id) !== "" || asString(m.national_id_last4) !== "" || m.national_id_provided === true) out.add("signatory_national_id");
  if (asString(m.date_of_birth) !== "" || m.date_of_birth_provided === true || m.dob_provided === true) out.add("signatory_dob");
  return out;
}

/* ---------------- validation ---------------- */
export type FieldErrorKey = Extract<MessageKey, `ob.form.err.${string}`>;

export function normalizeValue(f: FieldModel, raw: string): string {
  const v = raw.trim();
  switch (f.format) {
    case "phone": return normalizePhone(v) ?? v;
    case "national_id": return toAsciiDigits(v);
    case "tax_card_no": return toAsciiDigits(v);
    case "commercial_register_no": return toAsciiDigits(v).replace(/\\/g, "/");
    case "domain":
    case "url": return sellers.normaliseDomain(v) ?? v;
    case "country": return v.toUpperCase();
    case "date": return foldDigits(v);
    default: return v;
  }
}

export function validateField(
  f: FieldModel, raw: string, country: string, nowMs: number, alreadyProvided: boolean,
): FieldErrorKey | null {
  const v = normalizeValue(f, raw);
  if (v === "") return f.required && !alreadyProvided ? "ob.form.err.required" : null;
  if (f.input === "select") return f.options.some((o) => o.value === v) ? null : "ob.form.err.format";
  if (f.pattern !== null) {
    try {
      if (!new RegExp(f.pattern).test(v)) return "ob.form.err.format";
    } catch {
      // A malformed server pattern must not block the form; the server remains the authority.
    }
  }
  if (f.format === "date") {
    const age = sellers.ageInYears(v, nowMs);
    if (age === null) return "ob.form.err.date";
    if (f.minSignatoryAge !== null && age < f.minSignatoryAge) return "ob.form.err.under_age";
    return null;
  }
  return sellers.validateFieldValue(f.format, v, country) === null ? null : "ob.form.err.format";
}

export function validateAll(
  model: FormModel, values: FormValues, country: string, nowMs: number, provided: ReadonlySet<string>,
): Readonly<Record<string, FieldErrorKey>> {
  const errors: Record<string, FieldErrorKey> = {};
  for (const f of model.fields) {
    const e = validateField(f, values[f.code] ?? "", country, nowMs, provided.has(f.code));
    if (e !== null) errors[f.code] = e;
  }
  return errors;
}

/** Builds the PATCH body from non-empty values only (blank write-only fields keep the stored value). */
export function buildPatch(model: FormModel, values: FormValues): ApplicationPatch {
  const root: Record<string, unknown> = {};
  for (const f of model.fields) {
    const v = normalizeValue(f, values[f.code] ?? "");
    if (v === "") continue;
    const [a, b] = f.path;
    if (b === undefined) root[a] = v;
    else root[a] = { ...obj(root[a]), [b]: v };
  }
  return root as ApplicationPatch;
}

/* ---------------- documents ---------------- */
const MIME: Readonly<Record<"pdf" | "jpg" | "png", "application/pdf" | "image/jpeg" | "image/png">> = {
  pdf: "application/pdf", jpg: "image/jpeg", png: "image/png",
};

export type DocSlotState = "missing" | "awaiting" | "scanning" | "ready" | "infected" | "scan_error" | "rejected" | "unreadable" | "expired";

export function documentState(d: ApplicationDocument | null): DocSlotState {
  if (d === null) return "missing";
  if (d.upload_status === "awaiting_upload") return "awaiting";
  if (d.upload_status === "expired") return "expired";
  if (d.scan_status === "infected") return "infected";
  if (d.scan_status === "error") return "scan_error";
  if (d.scan_status === "pending") return "scanning";
  if (d.review_status === "rejected") return "rejected";
  if (d.review_status === "unreadable") return "unreadable";
  return "ready";
}

export const DOC_STATE_KEY: Readonly<Record<DocSlotState, MessageKey>> = {
  missing: "ob.doc.state.missing",
  awaiting: "ob.doc.state.awaiting",
  scanning: "ob.doc.state.scanning",
  ready: "ob.doc.state.ready",
  infected: "ob.doc.state.infected",
  scan_error: "ob.doc.state.scan_error",
  rejected: "ob.doc.state.rejected",
  unreadable: "ob.doc.state.unreadable",
  expired: "ob.doc.state.expired",
};

/** A slot needs a (re)upload unless its document is ready or still being scanned. */
export const docNeedsUpload = (s: DocSlotState): boolean => s !== "ready" && s !== "scanning";

export interface DocSlot {
  readonly code: string;
  readonly label: string;
  readonly help: string | null;
  readonly required: boolean;
  readonly group: string | null;
  readonly accepts: readonly ("application/pdf" | "image/jpeg" | "image/png")[];
  readonly acceptAttr: string;
  readonly maxBytes: number;
  readonly state: DocSlotState;
  readonly document: ApplicationDocument | null;
}

export function documentSlots(req: Requirements, app: Application | null, locale: Locale): readonly DocSlot[] {
  return req.documents.map((d) => {
    const mine = (app?.documents ?? []).filter((x) => x.requirement_code === d.code);
    const latest = mine.length === 0 ? null : [...mine].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
    const accepts = d.accepts.map((a) => MIME[a]);
    const help = locale === "ar" ? d.help_ar : d.help_en;
    return {
      code: d.code,
      label: locale === "ar" ? d.label_ar : d.label_en,
      help: help ?? null,
      required: d.required,
      group: d.one_of_group ?? null,
      accepts,
      acceptAttr: accepts.join(","),
      maxBytes: d.max_bytes,
      state: documentState(latest),
      document: latest,
    };
  });
}

export type FileProblem = "empty" | "too_large" | "type";
export const FILE_PROBLEM_KEY: Readonly<Record<FileProblem, MessageKey>> = {
  empty: "ob.doc.err.empty",
  too_large: "ob.doc.err.too_large",
  type: "ob.doc.err.type",
};

/** The declared type is only a first filter; the server sniffs magic bytes and scans for malware. */
export function validateFile(file: { readonly size: number; readonly type: string }, slot: { readonly accepts: readonly string[]; readonly maxBytes: number }): FileProblem | null {
  if (file.size <= 0) return "empty";
  if (file.size > slot.maxBytes) return "too_large";
  if (!slot.accepts.includes(file.type)) return "type";
  return null;
}

/** Document requirement groups: every plain required doc, and "one of" groups satisfied by any ready member. */
export function missingDocuments(slots: readonly DocSlot[]): readonly string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const s of slots) {
    if (!s.required) continue;
    if (s.group === null) {
      if (s.state !== "ready" && s.state !== "scanning") missing.push(s.code);
      continue;
    }
    if (seen.has(s.group)) continue;
    seen.add(s.group);
    const ok = slots.some((x) => x.group === s.group && (x.state === "ready" || x.state === "scanning"));
    if (!ok) missing.push(s.group);
  }
  return missing;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(Math.round((n / (1024 * 1024)) * 10) / 10).toString()} MB`;
}

export function uploadPercent(loaded: number, total: number): number {
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.floor((loaded * 100) / total)));
}

/* ---------------- readiness ---------------- */
export type StepId = "details" | "documents" | "domain" | "review";
export const STEPS: readonly StepId[] = ["details", "documents", "domain", "review"];

export interface Blocker {
  readonly step: StepId;
  readonly code: string;
  readonly messageKey: MessageKey;
}

export function domainRequired(req: Requirements, websiteDomain: string): boolean {
  if (req.website_verification === "required") return true;
  return req.website_verification === "required_if_website" && websiteDomain.trim() !== "";
}

export function submitBlockers(args: {
  readonly req: Requirements;
  readonly app: Application;
  readonly model: FormModel;
  readonly values: FormValues;
  readonly nowMs: number;
  readonly acks: { readonly agreement: boolean; readonly dpa: boolean; readonly monitoring: boolean };
}): readonly Blocker[] {
  const { req, app, model, values, nowMs, acks } = args;
  const out: Blocker[] = [];
  const errors = validateAll(model, values, app.country, nowMs, providedWriteOnly(app));
  for (const code of Object.keys(errors)) out.push({ step: "details", code, messageKey: "ob.blocker.field" });
  for (const code of missingDocuments(documentSlots(req, app, "en"))) out.push({ step: "documents", code, messageKey: "ob.blocker.document" });
  const website = values.website_domain ?? app.website_domain ?? "";
  if (domainRequired(req, website) && app.domain_verification?.status !== "verified") {
    out.push({ step: "domain", code: "domain", messageKey: "ob.blocker.domain" });
  }
  if (!acks.agreement) out.push({ step: "review", code: "agreement", messageKey: "ob.blocker.agreement" });
  if (!acks.dpa) out.push({ step: "review", code: "dpa", messageKey: "ob.blocker.dpa" });
  if (!acks.monitoring) out.push({ step: "review", code: "monitoring", messageKey: "ob.blocker.monitoring" });
  return out;
}

/** Defaults the country from the kind: local brands are Egypt only for now (spec 3). */
export const defaultCountry = (kind: "local" | "global"): string => (kind === "local" ? "EG" : "");

export function validateNewApplication(kind: "local" | "global" | null, country: string, brandName: string): Readonly<Record<string, MessageKey>> {
  const e: Record<string, MessageKey> = {};
  if (kind === null) e.kind = "ob.form.err.required";
  if (!/^[A-Z]{2}$/.test(country.trim().toUpperCase())) e.country = "ob.form.err.country";
  else if (kind === "local" && country.trim().toUpperCase() !== "EG") e.country = "ob.form.err.local_egypt";
  const n = brandName.trim();
  if (n.length < 2 || n.length > 120) e.brand_name = "ob.form.err.brand_name";
  return e;
}
