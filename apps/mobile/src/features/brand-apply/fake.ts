/** In-memory BrandApplyPort (development default and tests). Behaves like the server: gates, scanning delay, SLA field. */
import {
  BrandApplyError, MAX_UPLOAD_BYTES, buildChecklist, slotFromServer, validateDetails,
  type ApplicationPatch, type ApplicationView, type AppStatus, type BrandApplyPort, type BrandKind, type DocView, type DomainState,
  type OtpChallenge, type PasskeyChallenge, type ReqDoc, type ReqField, type Requirements, type TotpEnrolment, type UploadRequest,
} from "./model";

const bi = (en: string, ar: string) => ({ en, ar });
const DAY = 86_400_000;

const SIGNATORY: readonly ReqField[] = [
  { code: "signatory_full_name", label: bi("Signatory full name", "اسم المفوّض بالتوقيع"), required: true, format: "text" },
  { code: "signatory_national_id", label: bi("Signatory national ID", "الرقم القومي للمفوّض"), required: true, format: "national_id" },
  { code: "signatory_date_of_birth", label: bi("Signatory date of birth (YYYY-MM-DD)", "تاريخ ميلاد المفوّض (YYYY-MM-DD)"), required: true, format: "date", minSignatoryAge: 21 },
];
const CONTACT: readonly ReqField[] = [
  { code: "contact_name", label: bi("Contact person", "الشخص المسؤول"), required: true, format: "text" },
  { code: "contact_email", label: bi("Contact email", "البريد الإلكتروني للتواصل"), required: true, format: "email" },
];
const SOCIAL: readonly ReqField[] = [
  { code: "website_domain", label: bi("Website domain", "نطاق الموقع"), required: false, format: "domain" },
  { code: "instagram", label: bi("Instagram handle", "حساب إنستغرام"), required: false, format: "handle" },
  { code: "tiktok", label: bi("TikTok handle", "حساب تيك توك"), required: false, format: "handle" },
];
const FILES = ["pdf", "jpg", "png"] as const;
const doc = (code: string, en: string, ar: string, required: boolean, group?: string, help?: [string, string]): ReqDoc => ({
  code, label: bi(en, ar), required, ...(group !== undefined ? { group } : {}), accepts: FILES, maxBytes: MAX_UPLOAD_BYTES,
  ...(help !== undefined ? { help: bi(help[0], help[1]) } : {}),
});

export function fakeRequirements(kind: BrandKind, country: string): Requirements {
  if (kind === "local") {
    return {
      kind, country, version: 1, websiteVerification: "required_if_website",
      fields: [
        { code: "legal_name", label: bi("Registered legal name", "الاسم القانوني المسجّل"), required: true, format: "text" },
        { code: "commercial_register_no", label: bi("Commercial register number", "رقم السجل التجاري"), required: true, format: "commercial_register_no" },
        { code: "tax_card_no", label: bi("Tax card number", "رقم البطاقة الضريبية"), required: true, format: "tax_card_no" },
        ...SIGNATORY, ...CONTACT, ...SOCIAL,
      ],
      documents: [
        doc("commercial_register", "Commercial register", "السجل التجاري", true, undefined, ["A clear copy of the current extract.", "نسخة واضحة من المستخرج الحالي."]),
        doc("tax_card", "Tax card", "البطاقة الضريبية", true),
        doc("signatory_id", "Signatory national ID", "بطاقة الرقم القومي للمفوّض", true, undefined, ["Both sides, all four corners visible.", "الوجهان بوضوح وظهور الزوايا الأربع."]),
        doc("trademark_certificate", "Trademark certificate", "شهادة العلامة التجارية", true, "ownership"),
        doc("brand_authorization", "Brand authorisation letter", "خطاب تفويض من العلامة التجارية", false, "ownership"),
        doc("proof_of_purchase", "Proof of purchase", "إثبات الشراء", false, "ownership"),
      ],
    };
  }
  return {
    kind, country, version: 1, websiteVerification: "required",
    fields: [
      { code: "legal_name", label: bi("Registered company name", "اسم الشركة المسجّل"), required: true, format: "text" },
      { code: "company_reg_no", label: bi("Company registration number", "رقم تسجيل الشركة"), required: true, format: "company_reg_no" },
      { code: "vat_or_tax_id", label: bi("VAT or tax ID", "الرقم الضريبي"), required: false, format: "vat_id" },
      ...SIGNATORY, ...CONTACT,
      { code: "website_domain", label: bi("Brand website domain", "نطاق موقع العلامة"), required: true, format: "domain" },
      { code: "instagram", label: bi("Instagram handle", "حساب إنستغرام"), required: false, format: "handle" },
    ],
    documents: [
      doc("company_registration_extract", "Company registration extract", "مستخرج تسجيل الشركة", true),
      doc("signatory_id", "Signatory ID or passport", "هوية أو جواز المفوّض", true),
      doc("trademark_registration_certificate", "Trademark registration certificate", "شهادة تسجيل العلامة التجارية", true, "ownership"),
      doc("distributor_authorization_letter", "Distributor authorisation letter", "خطاب تفويض موزّع", false, "ownership"),
    ],
  };
}

interface Rec { app: ApplicationView; polls: number }

export class InMemoryBrandApplyPort implements BrandApplyPort {
  private strong = false;
  private otpVerified = false;
  private readonly apps = new Map<string, Rec>();
  private seq = 0;
  private domainChecks = 0;
  /** Milliseconds until a freshly uploaded document finishes scanning. */
  constructor(private readonly opts: { readonly latencyMs?: number; readonly scanMs?: number; readonly now?: () => number } = {}) {}

  private now(): number { return (this.opts.now ?? Date.now)(); }
  private async lag(): Promise<void> { const ms = this.opts.latencyMs ?? 180; if (ms > 0) await new Promise((r) => setTimeout(r, ms)); }
  private id(prefix: string): string { this.seq += 1; return `${prefix}-${String(this.seq).padStart(8, "0")}-fake`; }
  private rec(id: string): Rec { const r = this.apps.get(id); if (r === undefined) throw new BrandApplyError("not_found"); return r; }
  private set(r: Rec, patch: Partial<ApplicationView>): ApplicationView {
    r.app = { ...r.app, ...patch, version: `v${this.seq++}` };
    return r.app;
  }

  async requestOtp(i: { phone: string; email: string }): Promise<OtpChallenge> {
    await this.lag();
    if (i.phone.length < 8 || !i.email.includes("@")) throw new BrandApplyError("failed");
    return { challengeId: this.id("otp"), expiresIn: 300, resendAfter: 30 };
  }
  async verifyOtp(i: { challengeId?: string; code: string }): Promise<{ strongFactorEnrolled: boolean }> {
    await this.lag();
    if (i.code !== "123456") throw new BrandApplyError("invalid_code");
    this.otpVerified = true;
    return { strongFactorEnrolled: this.strong };
  }
  async getRequirements(kind: BrandKind, country: string): Promise<Requirements> { await this.lag(); return fakeRequirements(kind, country); }
  async passkeyOptions(): Promise<PasskeyChallenge> { await this.lag(); return { challengeId: this.id("pk"), publicKey: { challenge: "fake" } }; }
  async passkeyRegister(): Promise<void> { await this.lag(); this.strong = true; }
  async totpEnrol(): Promise<TotpEnrolment> {
    await this.lag();
    return {
      otpauthUri: "otpauth://totp/Z-OUTLET:brand?secret=JBSWY3DPEHPK3PXP&issuer=Z-OUTLET",
      secret: "JBSWY3DPEHPK3PXP",
      recoveryCodes: ["K7QM-2XDP", "9FHT-WL4C", "R3VN-8ZBA", "Y5JE-6GUS", "D2WK-N9TQ", "H8CX-4MRL", "B6PA-3YEV", "T4ZU-7JGN"],
    };
  }
  async totpConfirm(code: string): Promise<void> {
    await this.lag();
    if (!/^[0-9]{6}$/.test(code) || code !== "123456") throw new BrandApplyError("invalid_code");
    this.strong = true;
  }

  async totpAssert(code: string): Promise<void> {
    await this.lag();
    if (code !== "123456") throw new BrandApplyError("invalid_code");
  }

  async createApplication(i: { kind: BrandKind; country: string; brandName: string }): Promise<ApplicationView> {
    await this.lag();
    if (!this.otpVerified) throw new BrandApplyError("session_expired");
    const id = this.id("app");
    const t = new Date(this.now()).toISOString();
    const app: ApplicationView = {
      id, status: "DRAFT", kind: i.kind, country: i.country, brandName: i.brandName, values: {}, documents: [], requestedItems: [], decision: null,
      decisionDueAt: null, domain: null, allowedActions: ["edit", "submit", "withdraw", "upload_document", "verify_domain"], appealUsed: false,
      submittedAt: t, storeId: null, version: "v0",
    };
    this.apps.set(id, { app: { ...app, submittedAt: null }, polls: 0 });
    return this.rec(id).app;
  }

  async getApplication(id: string): Promise<ApplicationView> {
    await this.lag();
    const r = this.rec(id);
    r.polls += 1;
    const t = this.now();
    // Scanning finishes after a short delay; submitted applications move through the automated checks.
    const docs = r.app.documents.map((d) => (d.scanStatus === "pending" && t - Number(d.id.split("@")[1] ?? 0) > (this.opts.scanMs ?? 2200) ? { ...d, scanStatus: "clean" as const } : d));
    r.app = { ...r.app, documents: docs };
    if (r.app.status === "SUBMITTED" && r.polls > 1) this.set(r, { status: "AUTO_CHECKS" });
    return r.app;
  }
  async listMine(): Promise<readonly ApplicationView[]> { await this.lag(); return [...this.apps.values()].map((r) => r.app); }

  async updateApplication(id: string, patch: ApplicationPatch, _version?: string | null): Promise<ApplicationView> {
    await this.lag();
    const r = this.rec(id);
    if (!r.app.allowedActions.includes("edit")) throw new BrandApplyError("invalid_transition");
    return this.set(r, {
      ...(patch.brandName !== undefined ? { brandName: patch.brandName } : {}),
      ...(patch.ownershipBasis !== undefined ? { ownershipBasis: patch.ownershipBasis } : {}),
      values: { ...r.app.values, ...(patch.values ?? {}) },
    });
  }

  async uploadDocument(id: string, req: UploadRequest, onProgress: (r: number) => void): Promise<DocView> {
    const r = this.rec(id);
    if (req.sizeBytes > MAX_UPLOAD_BYTES) throw new BrandApplyError("document_rejected");
    for (let i = 1; i <= 5; i++) { await new Promise((res) => setTimeout(res, (this.opts.latencyMs ?? 180) / 2)); onProgress(i / 5); }
    const d: DocView = {
      id: `${this.id("doc")}@${this.now()}`, requirementCode: req.requirementCode, contentType: req.contentType, sizeBytes: req.sizeBytes,
      uploadStatus: "uploaded", scanStatus: "pending", reviewStatus: "unreviewed",
    };
    this.set(r, { documents: [...r.app.documents.filter((x) => x.requirementCode !== req.requirementCode), d] });
    return d;
  }
  async deleteDocument(id: string, docId: string): Promise<void> {
    await this.lag();
    const r = this.rec(id);
    this.set(r, { documents: r.app.documents.filter((d) => d.id !== docId) });
  }

  async startDomain(id: string, method: "dns_txt" | "email"): Promise<DomainState> {
    await this.lag();
    const r = this.rec(id);
    const domain = r.app.values["website_domain"] ?? "";
    if (domain === "") throw new BrandApplyError("failed");
    this.domainChecks = 0;
    const d: DomainState = {
      method, domain, status: "pending", expiresAt: new Date(this.now() + 7 * DAY).toISOString(),
      ...(method === "dns_txt" ? { txtName: `_zoutlet-verify.${domain}`, txtValue: "zoutlet-site-verification=7c1e9a4f52b0d3a86e" } : { emailMasked: `a***@${domain}` }),
    };
    this.set(r, { domain: d });
    return d;
  }
  async confirmDomain(id: string, code?: string): Promise<DomainState> {
    await this.lag();
    const r = this.rec(id);
    const cur = r.app.domain;
    if (cur === null) throw new BrandApplyError("failed");
    this.domainChecks += 1;
    // DNS lag is honest: the first check is still pending, the next one verifies.
    const ok = cur.method === "email" ? code === "123456" : this.domainChecks >= 2;
    const next: DomainState = { ...cur, status: ok ? "verified" : "pending" };
    this.set(r, { domain: next });
    return next;
  }

  private checkSubmit(r: Rec, req: Requirements): void {
    if (!this.strong) throw new BrandApplyError("strong_factor_required");
    const slots = Object.fromEntries(r.app.documents.map((d) => [d.requirementCode, slotFromServer(d)]));
    if (!buildChecklist(req.documents, slots).complete) throw new BrandApplyError("checklist_incomplete");
    if (Object.keys(validateDetails(req.fields, r.app.values)).length > 0) throw new BrandApplyError("checklist_incomplete");
  }
  async submit(id: string): Promise<ApplicationView> {
    await this.lag();
    const r = this.rec(id);
    this.checkSubmit(r, fakeRequirements(r.app.kind, r.app.country));
    return this.set(r, {
      status: "SUBMITTED", submittedAt: new Date(this.now()).toISOString(), decisionDueAt: new Date(this.now() + 5 * DAY).toISOString(), allowedActions: ["withdraw"],
    });
  }
  async resubmit(id: string): Promise<ApplicationView> {
    await this.lag();
    const r = this.rec(id);
    if (r.app.status !== "NEEDS_INFO") throw new BrandApplyError("invalid_transition");
    r.polls = 0;
    return this.set(r, { status: "SUBMITTED", requestedItems: [], decisionDueAt: new Date(this.now() + 5 * DAY).toISOString(), allowedActions: ["withdraw"] });
  }
  async appeal(id: string): Promise<ApplicationView> {
    await this.lag();
    const r = this.rec(id);
    if (r.app.status !== "REJECTED" || r.app.appealUsed) throw new BrandApplyError("invalid_transition");
    return this.set(r, { status: "IN_REVIEW", appealUsed: true, allowedActions: ["withdraw"], decisionDueAt: new Date(this.now() + 5 * DAY).toISOString() });
  }
  async withdraw(id: string): Promise<ApplicationView> {
    await this.lag();
    return this.set(this.rec(id), { status: "WITHDRAWN", allowedActions: [] });
  }

  /** Development only: jump an application to a status so every state of the status screen can be reviewed. */
  devSetStatus(id: string, status: AppStatus): ApplicationView {
    const r = this.rec(id);
    const t = this.now();
    const decidedAt = new Date(t - 2 * DAY).toISOString();
    const base: Partial<ApplicationView> = { status };
    switch (status) {
      case "NEEDS_INFO":
        return this.set(r, { ...base, allowedActions: ["edit", "resubmit", "withdraw", "upload_document"], decision: null, requestedItems: [
          { code: "tax_card", kind: "document", message: bi("The tax card photo is cropped. Upload the full card.", "صورة البطاقة الضريبية مقصوصة. ارفع البطاقة كاملة."), satisfied: false },
          { code: "contact_email", kind: "field", message: bi("Use an email at your brand domain.", "استخدم بريداً إلكترونياً على نطاق علامتك."), satisfied: false },
        ] });
      case "REJECTED":
        return this.set(r, { ...base, allowedActions: ["appeal"], decision: {
          decision: "rejected", reasonCode: "ownership_not_proven", decidedAt, reapplyAfter: new Date(t + 28 * DAY).toISOString(), appealAllowed: true,
          message: bi("We could not match the trademark certificate to the legal name on the application.", "لم نتمكن من مطابقة شهادة العلامة التجارية مع الاسم القانوني في الطلب."),
        } });
      case "APPROVED":
        return this.set(r, { ...base, allowedActions: [], storeId: "00000000-0000-4000-8000-00000000fake", decision: {
          decision: "approved", reasonCode: "ok", decidedAt, reapplyAfter: null, appealAllowed: false, message: bi("Welcome to Z-OUTLET.", "أهلاً بك في Z-OUTLET."),
        } });
      case "SUBMITTED": case "AUTO_CHECKS": case "IN_REVIEW":
        return this.set(r, { ...base, allowedActions: ["withdraw"], decisionDueAt: new Date(t + 4 * DAY).toISOString(), submittedAt: new Date(t - DAY).toISOString() });
      default:
        return this.set(r, base);
    }
  }
}
