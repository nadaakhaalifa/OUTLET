import { sellers } from "@outlet/domain";
import type { Clock, IdGenerator } from "../../../platform/ports";
import {
  acknowledgementsAccepted,
  decodeView,
  documentFacts,
  encryptPii,
  filenameAad,
  flatFields,
  nationalIdAad,
  type ApplicationView,
  type Pii,
} from "./codec";
import type {
  AggregateRow,
  ApplicationRow,
  BrandApplicationRepository,
  BrandDocumentStore,
  Commit,
  Cursor,
  DocumentRow,
  FieldCipherPort,
  FunnelAnalyticsPort,
  HistoryDraft,
  OutboxEventDraft,
  Page,
  RepoScope,
  RequestedItem,
  ScanPort,
  VerificationLink,
} from "../domain/ports";

export interface Violation {
  readonly pointer: string;
  readonly code: string;
}

type Opt<T> = { [K in keyof T]?: T[K] | undefined };

export interface ApplicationPatch {
  readonly brandName?: string | undefined;
  readonly legalName?: string | undefined;
  readonly registration?: Opt<{
    commercialRegisterNo: string;
    taxCardNo: string;
    companyRegNo: string;
    companyRegCountry: string;
    vatOrTaxId: string;
  }> | undefined;
  readonly trademark?: Opt<{ register: string; number: string; ownerName: string }> | undefined;
  readonly ownershipBasis?: sellers.OwnershipBasis | undefined;
  readonly websiteDomain?: string | undefined;
  readonly socialHandles?: Readonly<Record<string, string>> | undefined;
  readonly contact?: Opt<{ name: string; phoneE164: string; email: string }> | undefined;
  readonly signatory?: Opt<{ fullName: string; nationalId: string; dateOfBirth: string }> | undefined;
  readonly etaRegistration?: string | undefined;
  readonly descriptionAr?: string | undefined;
  readonly descriptionEn?: string | undefined;
  readonly acknowledgements?: Opt<{ sellerAgreementVersion: string; dpaVersion: string; priceMonitoringConsent: boolean }> | undefined;
}

export type Result<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "not_found" }
  | { readonly kind: "not_editable"; readonly status: sellers.ApplicationStatus }
  | { readonly kind: "invalid"; readonly violations: readonly Violation[] }
  | { readonly kind: "duplicate_active" }
  | { readonly kind: "cooldown"; readonly reapplyAfterMs: number }
  | { readonly kind: "conflict" }
  | { readonly kind: "strong_factor_required" }
  | { readonly kind: "incomplete"; readonly missing: readonly sellers.MissingItem[] }
  | { readonly kind: "invalid_transition"; readonly from: sellers.ApplicationStatus }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number }
  | { readonly kind: "upload_missing" }
  | { readonly kind: "invalid_content"; readonly code: "size_mismatch" | "magic_bytes_mismatch" }
  | { readonly kind: "not_applicable"; readonly code: string };

export interface SellersDeps {
  readonly repo: BrandApplicationRepository;
  readonly cipher: FieldCipherPort;
  readonly store: BrandDocumentStore;
  readonly scanner: ScanPort;
  readonly verification: VerificationLink;
  readonly analytics: FunnelAnalyticsPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Optional: whether a store already has its English display name (go-live checklist). Null = unknown. */
  readonly storeNames?: StoreNameLookup;
}

export interface StoreNameLookup {
  hasEnglishName(storeId: string): Promise<boolean | null>;
}

const UPLOAD_TTL_SECONDS = 600;
const HOUR_MS = 3_600_000;
const EDITABLE = new Set<sellers.ApplicationStatus>(sellers.EDITABLE_STATUSES);

export const ok = <T>(value: T): Result<T> => ({ kind: "ok", value });

/** Applicant-side commands and queries. The admin side lives in admin-port.ts and shares `commitTransition`. */
export class BrandApplicationService {
  constructor(readonly d: SellersDeps) {}

  // ---------------------------------------------------------------- shared helpers

  scopeOf(applicantId: string): RepoScope {
    return { kind: "applicant", applicantId };
  }

  async view(agg: AggregateRow): Promise<ApplicationView> {
    return decodeView(this.d.cipher, agg.app, agg.documents);
  }

  draftEvent(row: ApplicationRow, type: string, nowMs: number, extra: Record<string, string | number | boolean | null> = {}): OutboxEventDraft {
    return {
      id: this.d.ids.uuidV7(),
      type,
      aggregateId: row.id,
      occurredAtMs: nowMs,
      payload: { application_id: row.id, brand_kind: row.brandKind, country: row.country, status: row.status, ...extra },
    };
  }

  draftHistory(row: ApplicationRow, to: sellers.ApplicationStatus, event: string, actor: HistoryDraft["actorType"], actorId: string | null, nowMs: number, reason: string | null = null): HistoryDraft {
    return { id: this.d.ids.uuidV7(), fromStatus: row.status, toStatus: to, event, actorType: actor, actorId, reasonCode: reason, occurredAtMs: nowMs };
  }

  /** Domain verified by brand-verification for the domain currently claimed on the application. */
  async domainVerified(row: ApplicationRow): Promise<boolean> {
    if (row.websiteDomain === null) return false;
    const dv = await this.d.verification.domainState(row.id);
    return dv !== null && dv.status === "verified" && dv.domain === row.websiteDomain;
  }

  completeness(v: ApplicationView, nowMs: number, domainVerified?: boolean) {
    const req = sellers.getRequirements(v.row.brandKind, v.row.country);
    const dv = domainVerified ?? v.row.domainVerification?.status === "verified";
    return {
      req,
      result: sellers.evaluateCompleteness(req, {
        country: v.row.country,
        fields: flatFields(v),
        documents: documentFacts(v.documents),
        domainVerified: dv,
        acknowledgementsAccepted: acknowledgementsAccepted(v.row),
        nowMs,
      }),
    };
  }

  /** KYC context facts derived from the stored application. `sanctionsClear` is attested by the reviewer. */
  contextFor(v: ApplicationView, nowMs: number, over: Partial<sellers.ApplicationContext> = {}): sellers.ApplicationContext {
    const { result } = this.completeness(v, nowMs);
    const kinds = new Set(result.missing.map((m) => m.kind));
    return {
      documentsValid: !kinds.has("document") && !kinds.has("document_pending_scan"),
      sanctionsClear: false,
      signatoryAdult21: !kinds.has("signatory_age") && flatFields(v)["signatory_dob"] !== undefined,
      requestedItemsSatisfied: sellers.allRequestedSatisfied(v.row.requestedItems),
      appealOpen: sellers.appealOpen(v.row.status, v.row.rejectedAtMs, v.row.appealUsed, nowMs),
      ...over,
    };
  }

  allowed(v: ApplicationView, nowMs: number): readonly sellers.ApplicationAction[] {
    const { req } = this.completeness(v, nowMs);
    const hasSite = v.row.websiteDomain !== null;
    return sellers.allowedActions(v.row.status, {
      appealOpen: sellers.appealOpen(v.row.status, v.row.rejectedAtMs, v.row.appealUsed, nowMs),
      domainVerificationNeeded: req.website_verification === "required" || (req.website_verification === "required_if_website" && hasSite),
    });
  }

  private async load(applicantId: string, id: string): Promise<AggregateRow | null> {
    return this.d.repo.get(id, this.scopeOf(applicantId));
  }

  private async commit(c: Commit): Promise<"ok" | "conflict" | "not_found" | "duplicate_active"> {
    return this.d.repo.commit(c);
  }

  // ---------------------------------------------------------------- queries

  requirements(kind: sellers.BrandKind, country: string) {
    return sellers.getRequirements(kind, country);
  }

  async list(applicantId: string, after: Cursor | null, limit: number): Promise<Page<ApplicationView>> {
    const page = await this.d.repo.listForApplicant(applicantId, after, limit);
    return { items: await Promise.all(page.items.map((a) => this.view(a))), next: page.next };
  }

  async get(applicantId: string, id: string): Promise<ApplicationView | null> {
    const agg = await this.load(applicantId, id);
    return agg === null ? null : this.view(agg);
  }

  /** First-login checklist for the applicant's provisioned (APPROVED with store) application. */
  async onboardingChecklist(applicantId: string): Promise<{ storeId: string; items: { code: string; done: boolean; requiredForPublish: boolean }[] } | null> {
    const page = await this.d.repo.listForApplicant(applicantId, null, 50);
    const approved = page.items.find((a) => a.app.status === "APPROVED" && a.app.storeId !== null);
    if (approved === undefined || approved.app.storeId === null) return null;
    const hasEn = (await this.d.storeNames?.hasEnglishName(approved.app.storeId)) ?? false;
    const items = [
      { code: "complete_store_profile", done: false, requiredForPublish: true },
      { code: "add_english_store_name", done: hasEn, requiredForPublish: true },
      { code: "add_payout_iban", done: false, requiredForPublish: true },
      { code: "enrol_eta_receipts", done: approved.app.etaRegistration === "registered", requiredForPublish: false },
      { code: "add_first_product", done: false, requiredForPublish: true },
      { code: "set_shipping_origin", done: false, requiredForPublish: true },
      { code: "invite_team", done: false, requiredForPublish: false },
    ];
    return { storeId: approved.app.storeId, items };
  }

  // ---------------------------------------------------------------- create / patch

  async create(applicantId: string, i: { brandKind: sellers.BrandKind; country: string; brandName: string }): Promise<Result<ApplicationView>> {
    const violations: Violation[] = [];
    if (i.brandKind === "local" && i.country !== "EG") violations.push({ pointer: "/country", code: "local_requires_egypt" });
    const name = i.brandName.trim();
    const norm = sellers.normaliseBrandName(name);
    if (name.length < 2 || norm.length === 0) violations.push({ pointer: "/brand_name", code: "invalid_format" });
    if (violations.length > 0) return { kind: "invalid", violations };
    const nowMs = this.d.clock.nowMs();
    const rejectedAt = await this.d.repo.lastRejectedAtMs(applicantId, norm);
    if (rejectedAt !== null && !sellers.reapplyAllowed(rejectedAt, nowMs)) return { kind: "cooldown", reapplyAfterMs: sellers.reapplyAfterMs(rejectedAt) };
    const id = this.d.ids.uuidV7();
    const row: ApplicationRow = {
      id, applicantId, status: "DRAFT", version: 0, brandKind: i.brandKind, country: i.country, brandName: name, brandNameNorm: norm,
      ownershipBasis: null, trademarkRegister: null, trademarkNumber: null, trademarkOwnerName: null, commercialRegisterNo: null,
      taxCardNo: null, companyRegNo: null, companyRegCountry: null, vatOrTaxId: null, websiteDomain: null, socialHandles: {},
      etaRegistration: null, descriptionAr: null, descriptionEn: null, acknowledgements: {}, piiEnc: null, nationalIdEnc: null,
      nationalIdBlind: null, domainVerification: null, appealUsed: false, appealStatement: null, submittedAtMs: null, decision: null,
      decisionDueAtMs: null, rejectedAtMs: null, storeId: null, assigneeId: null, claimedAtMs: null, requestedItems: [],
      requestedAtMs: null, createdAtMs: nowMs, updatedAtMs: nowMs,
    };
    const history: HistoryDraft = { id: this.d.ids.uuidV7(), fromStatus: "DRAFT", toStatus: "DRAFT", event: "CREATE", actorType: "APPLICANT", actorId: applicantId, reasonCode: null, occurredAtMs: nowMs };
    const res = await this.d.repo.insert(row, history, []);
    if (res === "duplicate_active") return { kind: "duplicate_active" };
    this.d.analytics.track({ name: "brand_application_started", props: { brand_kind: i.brandKind, country: i.country } });
    return ok(await this.view({ app: row, documents: [] }));
  }

  async patch(applicantId: string, id: string, p: ApplicationPatch): Promise<Result<ApplicationView>> {
    const agg = await this.load(applicantId, id);
    if (agg === null) return { kind: "not_found" };
    const row = agg.app;
    if (!EDITABLE.has(row.status)) return { kind: "not_editable", status: row.status };
    const nowMs = this.d.clock.nowMs();
    const v = await this.view(agg);
    const req = sellers.getRequirements(row.brandKind, row.country);
    const formatOf = new Map(req.fields.map((f) => [f.code, f.format] as const));
    const violations: Violation[] = [];
    const changed = new Set<string>();
    const check = (code: string, pointer: string, value: string | undefined) => {
      if (value === undefined) return;
      changed.add(code);
      const fmt = formatOf.get(code);
      const err = fmt === undefined ? null : sellers.validateFieldValue(fmt, value, row.country);
      if (err !== null) violations.push({ pointer, code: err });
    };
    check("brand_name", "/brand_name", p.brandName);
    check("legal_name", "/legal_name", p.legalName);
    check("commercial_register_no", "/registration/commercial_register_no", p.registration?.commercialRegisterNo);
    check("tax_card_no", "/registration/tax_card_no", p.registration?.taxCardNo);
    check("company_reg_no", "/registration/company_reg_no", p.registration?.companyRegNo);
    check("company_reg_country", "/registration/company_reg_country", p.registration?.companyRegCountry);
    check("vat_or_tax_id", "/registration/vat_or_tax_id", p.registration?.vatOrTaxId);
    check("trademark_number", "/trademark/number", p.trademark?.number);
    check("contact_name", "/contact/name", p.contact?.name);
    check("contact_phone", "/contact/phone_e164", p.contact?.phoneE164);
    check("contact_email", "/contact/email", p.contact?.email);
    check("signatory_full_name", "/signatory/full_name", p.signatory?.fullName);
    check("signatory_national_id", "/signatory/national_id", p.signatory?.nationalId);
    check("signatory_dob", "/signatory/date_of_birth", p.signatory?.dateOfBirth);
    if (p.ownershipBasis !== undefined) changed.add("ownership_basis");
    if (p.etaRegistration !== undefined) changed.add("eta_registration");
    let domain: string | null | undefined;
    if (p.websiteDomain !== undefined) {
      domain = sellers.normaliseDomain(p.websiteDomain);
      if (domain === null) violations.push({ pointer: "/website_domain", code: "invalid_format" });
      else changed.add("website_domain");
    }
    if (p.signatory?.dateOfBirth !== undefined && sellers.ageInYears(p.signatory.dateOfBirth, nowMs) === null) {
      violations.push({ pointer: "/signatory/date_of_birth", code: "invalid_date" });
    }
    if (p.brandName !== undefined && sellers.normaliseBrandName(p.brandName).length === 0) violations.push({ pointer: "/brand_name", code: "invalid_format" });
    if (violations.length > 0) return { kind: "invalid", violations };

    const pii: Pii = {
      ...v.pii,
      ...(p.legalName !== undefined ? { legalName: p.legalName } : {}),
      ...(p.contact?.name !== undefined ? { contactName: p.contact.name } : {}),
      ...(p.contact?.phoneE164 !== undefined ? { contactPhone: p.contact.phoneE164 } : {}),
      ...(p.contact?.email !== undefined ? { contactEmail: p.contact.email } : {}),
      ...(p.signatory?.fullName !== undefined ? { signatoryFullName: p.signatory.fullName } : {}),
      ...(p.signatory?.dateOfBirth !== undefined ? { signatoryDob: p.signatory.dateOfBirth } : {}),
    };
    const nid = p.signatory?.nationalId?.trim();
    const brandName = p.brandName !== undefined ? p.brandName.trim() : row.brandName;
    const domainChanged = domain !== undefined && domain !== row.websiteDomain;
    const ack = p.acknowledgements;
    const next: ApplicationRow = {
      ...row,
      brandName,
      brandNameNorm: sellers.normaliseBrandName(brandName),
      ownershipBasis: p.ownershipBasis ?? row.ownershipBasis,
      trademarkRegister: p.trademark?.register ?? row.trademarkRegister,
      trademarkNumber: p.trademark?.number ?? row.trademarkNumber,
      trademarkOwnerName: p.trademark?.ownerName ?? row.trademarkOwnerName,
      commercialRegisterNo: p.registration?.commercialRegisterNo?.trim() ?? row.commercialRegisterNo,
      taxCardNo: p.registration?.taxCardNo?.trim() ?? row.taxCardNo,
      companyRegNo: p.registration?.companyRegNo?.trim() ?? row.companyRegNo,
      companyRegCountry: p.registration?.companyRegCountry ?? row.companyRegCountry,
      vatOrTaxId: p.registration?.vatOrTaxId?.trim() ?? row.vatOrTaxId,
      websiteDomain: domain ?? row.websiteDomain,
      socialHandles: p.socialHandles ?? row.socialHandles,
      etaRegistration: p.etaRegistration ?? row.etaRegistration,
      descriptionAr: p.descriptionAr ?? row.descriptionAr,
      descriptionEn: p.descriptionEn ?? row.descriptionEn,
      acknowledgements: ack === undefined ? row.acknowledgements : {
        ...row.acknowledgements,
        ...(ack.sellerAgreementVersion !== undefined ? { seller_agreement_version: ack.sellerAgreementVersion } : {}),
        ...(ack.dpaVersion !== undefined ? { dpa_version: ack.dpaVersion } : {}),
        ...(ack.priceMonitoringConsent !== undefined ? { price_monitoring_consent: ack.priceMonitoringConsent } : {}),
      },
      piiEnc: await encryptPii(this.d.cipher, id, pii),
      nationalIdEnc: nid === undefined ? row.nationalIdEnc : await this.d.cipher.encrypt(nid, nationalIdAad(id)),
      nationalIdBlind: nid === undefined ? row.nationalIdBlind : await this.d.cipher.blindIndex("brand-national-id", nid),
      domainVerification: domainChanged ? null : row.domainVerification,
      requestedItems: sellers.resolveRequestedItems(row.requestedItems, {
        newDocumentCodes: new Set(),
        changedFieldCodes: changed,
        domainVerified: false,
        clarifiedCodes: new Set(),
      }),
      version: row.version + 1,
      updatedAtMs: nowMs,
    };
    const res = await this.commit({ scope: this.scopeOf(applicantId), expectedVersion: row.version, app: next, documentsUpsert: [], documentsDelete: [], history: null, events: [] });
    if (res !== "ok") return res === "not_found" ? { kind: "not_found" } : res === "conflict" ? { kind: "conflict" } : { kind: "duplicate_active" };
    return ok(await this.view({ app: next, documents: agg.documents }));
  }

  // ---------------------------------------------------------------- lifecycle

  private async transition(
    applicantId: string,
    id: string,
    event: sellers.ApplicationEvent,
    opts: { strongFactor?: boolean; requireComplete?: boolean; clarified?: ReadonlySet<string>; appealStatement?: string; analytics?: "submitted" | "resubmitted" | "withdrawn" | "appealed"; eventType?: string },
  ): Promise<Result<ApplicationView>> {
    const agg = await this.load(applicantId, id);
    if (agg === null) return { kind: "not_found" };
    const nowMs = this.d.clock.nowMs();
    let v = await this.view(agg);
    const dvState = await this.d.verification.domainState(id);
    const dvOk = dvState !== null && dvState.status === "verified" && dvState.domain === v.row.websiteDomain;
    v = { ...v, row: { ...v.row, domainVerification: dvState } };
    if ((event === "SUBMIT" || event === "RESUBMIT") && opts.strongFactor !== true) return { kind: "strong_factor_required" };
    if (event === "RESUBMIT" && opts.clarified !== undefined) {
      const items = sellers.resolveRequestedItems(v.row.requestedItems, { newDocumentCodes: new Set(), changedFieldCodes: new Set(), domainVerified: dvOk, clarifiedCodes: opts.clarified });
      v = { ...v, row: { ...v.row, requestedItems: items } };
    }
    if (opts.requireComplete === true) {
      // Documents satisfy requested items only when they were uploaded after the request was made.
      const { result } = this.completeness(v, nowMs, dvOk);
      if (!result.complete) return { kind: "incomplete", missing: result.missing };
    }
    let t: sellers.ApplicationTransition;
    try {
      t = sellers.applyApplicationEvent(v.row.status, event, this.contextFor(v, nowMs));
    } catch {
      return { kind: "invalid_transition", from: v.row.status };
    }
    const rejected = t.to === "REJECTED";
    const next: ApplicationRow = {
      ...v.row,
      status: t.to,
      submittedAtMs: event === "SUBMIT" || event === "RESUBMIT" ? nowMs : v.row.submittedAtMs,
      decisionDueAtMs: event === "SUBMIT" || event === "RESUBMIT" ? sellers.decisionDueMs(nowMs) : v.row.decisionDueAtMs,
      appealUsed: event === "APPEAL" ? true : v.row.appealUsed,
      appealStatement: opts.appealStatement ?? v.row.appealStatement,
      rejectedAtMs: rejected ? nowMs : v.row.rejectedAtMs,
      decision: event === "APPEAL" ? null : v.row.decision,
      assigneeId: event === "RESUBMIT" || event === "APPEAL" ? null : v.row.assigneeId,
      version: v.row.version + 1,
      updatedAtMs: nowMs,
    };
    const type = opts.eventType ?? `brand_application.${event === "WITHDRAW" ? "withdrawn" : event === "APPEAL" ? "appealed" : "submitted"}`;
    const events = [this.draftEvent(next, type, nowMs, { from_status: t.from, to_status: t.to, ...(event === "RESUBMIT" ? { resubmission: true } : {}) })];
    const res = await this.commit({
      scope: this.scopeOf(applicantId), expectedVersion: agg.app.version, app: next, documentsUpsert: [], documentsDelete: [],
      history: this.draftHistory(agg.app, t.to, event, "APPLICANT", applicantId, nowMs), events,
    });
    if (res !== "ok") return res === "not_found" ? { kind: "not_found" } : { kind: "conflict" };
    if (opts.analytics !== undefined) {
      this.d.analytics.track({ name: `brand_application_${opts.analytics}`, props: { brand_kind: next.brandKind, country: next.country } });
    }
    return ok(await this.view({ app: next, documents: agg.documents }));
  }

  submit(applicantId: string, id: string, strongFactor: boolean) {
    return this.transition(applicantId, id, "SUBMIT", { strongFactor, requireComplete: true, analytics: "submitted" });
  }
  resubmit(applicantId: string, id: string, strongFactor: boolean, clarified: ReadonlySet<string>) {
    return this.transition(applicantId, id, "RESUBMIT", { strongFactor, requireComplete: true, clarified, analytics: "resubmitted" });
  }
  withdraw(applicantId: string, id: string) {
    return this.transition(applicantId, id, "WITHDRAW", { analytics: "withdrawn" });
  }
  appeal(applicantId: string, id: string, statement: string) {
    return this.transition(applicantId, id, "APPEAL", { appealStatement: statement, analytics: "appealed" });
  }

  // ---------------------------------------------------------------- documents

  async createDocument(
    applicantId: string,
    id: string,
    i: { requirementCode: string; contentType: sellers.DocumentContentType; sizeBytes: number; sha256: string; originalFilename?: string },
  ): Promise<Result<{ document: DocumentRow; upload: { url: string; method: "PUT"; headers: Readonly<Record<string, string>>; expiresAtMs: number } }>> {
    const agg = await this.load(applicantId, id);
    if (agg === null) return { kind: "not_found" };
    if (!EDITABLE.has(agg.app.status)) return { kind: "not_editable", status: agg.app.status };
    const req = sellers.getRequirements(agg.app.brandKind, agg.app.country);
    const spec = req.documents.find((d) => d.code === i.requirementCode);
    if (spec === undefined) return { kind: "invalid", violations: [{ pointer: "/requirement_code", code: "unknown_requirement" }] };
    const accepted = spec.accepts.map((a) => (a === "pdf" ? "application/pdf" : a === "jpg" ? "image/jpeg" : "image/png"));
    if (!accepted.includes(i.contentType)) return { kind: "invalid", violations: [{ pointer: "/content_type", code: "unsupported_type" }] };
    if (i.sizeBytes < 1 || i.sizeBytes > Math.min(spec.max_bytes, sellers.MAX_DOCUMENT_BYTES)) return { kind: "invalid", violations: [{ pointer: "/size_bytes", code: "too_large" }] };
    const nowMs = this.d.clock.nowMs();
    const recent = await this.d.repo.countDocumentsSince(id, nowMs - HOUR_MS);
    if (recent >= sellers.DOCUMENT_UPLOADS_PER_HOUR) return { kind: "rate_limited", retryAfterSeconds: 3600 };
    const docId = this.d.ids.uuidV7();
    const dt = new Date(nowMs);
    // Key: purpose/yyyy/mm/uuid. No applicant, application, brand or file name.
    const objectKey = `kyc/${dt.getUTCFullYear()}/${String(dt.getUTCMonth() + 1).padStart(2, "0")}/${docId}`;
    const upload = await this.d.store.createUploadUrl({ key: objectKey, contentType: i.contentType, sizeBytes: i.sizeBytes, sha256: i.sha256, ttlSeconds: UPLOAD_TTL_SECONDS });
    const doc: DocumentRow = {
      id: docId, applicationId: id, applicantId, requirementCode: i.requirementCode,
      originalFilenameEnc: i.originalFilename === undefined ? null : await this.d.cipher.encrypt(i.originalFilename, filenameAad(docId)),
      contentType: i.contentType, sizeBytes: i.sizeBytes, sha256: i.sha256, objectKey, uploadStatus: "awaiting_upload", scanStatus: "pending",
      reviewStatus: "unreviewed", reviewNotePublic: null, reviewNoteInternal: null, createdAtMs: nowMs, uploadedAtMs: null,
    };
    const next: ApplicationRow = { ...agg.app, version: agg.app.version + 1, updatedAtMs: nowMs };
    const res = await this.commit({ scope: this.scopeOf(applicantId), expectedVersion: agg.app.version, app: next, documentsUpsert: [doc], documentsDelete: [], history: null, events: [] });
    if (res !== "ok") return { kind: "conflict" };
    return ok({ document: doc, upload: { url: upload.url, method: upload.method, headers: upload.headers, expiresAtMs: upload.expiresAtMs } });
  }

  async confirmDocument(applicantId: string, id: string, documentId: string): Promise<Result<{ app: ApplicationView; document: DocumentRow }>> {
    const agg = await this.load(applicantId, id);
    if (agg === null) return { kind: "not_found" };
    const doc = agg.documents.find((d) => d.id === documentId);
    if (doc === undefined) return { kind: "not_found" };
    if (!EDITABLE.has(agg.app.status)) return { kind: "not_editable", status: agg.app.status };
    const nowMs = this.d.clock.nowMs();
    if (doc.uploadStatus === "uploaded") return ok({ app: await this.view(agg), document: doc });
    const stat = await this.d.store.stat(doc.objectKey);
    if (stat === null) return { kind: "upload_missing" };
    const bad = stat.sizeBytes !== doc.sizeBytes ? "size_mismatch" : !sellers.matchesMagicBytes(doc.contentType, stat.head) ? "magic_bytes_mismatch" : null;
    if (bad !== null) {
      await this.d.store.delete(doc.objectKey);
      const gone: ApplicationRow = { ...agg.app, version: agg.app.version + 1, updatedAtMs: nowMs };
      await this.commit({ scope: this.scopeOf(applicantId), expectedVersion: agg.app.version, app: gone, documentsUpsert: [], documentsDelete: [doc.id], history: null, events: [] });
      return { kind: "invalid_content", code: bad };
    }
    const verdict = await this.d.scanner.scan(doc.objectKey);
    if (verdict === "infected") await this.d.store.delete(doc.objectKey);
    const confirmed: DocumentRow = { ...doc, uploadStatus: "uploaded", scanStatus: verdict, uploadedAtMs: nowMs };
    const next: ApplicationRow = {
      ...agg.app,
      requestedItems: verdict === "clean"
        ? sellers.resolveRequestedItems(agg.app.requestedItems, { newDocumentCodes: new Set([doc.requirementCode]), changedFieldCodes: new Set(), domainVerified: false, clarifiedCodes: new Set() })
        : agg.app.requestedItems,
      version: agg.app.version + 1,
      updatedAtMs: nowMs,
    };
    const res = await this.commit({ scope: this.scopeOf(applicantId), expectedVersion: agg.app.version, app: next, documentsUpsert: [confirmed], documentsDelete: [], history: null, events: [] });
    if (res !== "ok") return { kind: "conflict" };
    this.d.analytics.track({ name: "brand_document_uploaded", props: { requirement_code: doc.requirementCode, scan_status: verdict } });
    return ok({ app: await this.view({ app: next, documents: agg.documents.map((x) => (x.id === doc.id ? confirmed : x)) }), document: confirmed });
  }

  async deleteDocument(applicantId: string, id: string, documentId: string): Promise<Result<true>> {
    const agg = await this.load(applicantId, id);
    if (agg === null) return { kind: "not_found" };
    const doc = agg.documents.find((d) => d.id === documentId);
    if (doc === undefined) return { kind: "not_found" };
    if (!EDITABLE.has(agg.app.status)) return { kind: "not_editable", status: agg.app.status };
    const nowMs = this.d.clock.nowMs();
    const next: ApplicationRow = { ...agg.app, version: agg.app.version + 1, updatedAtMs: nowMs };
    const res = await this.commit({ scope: this.scopeOf(applicantId), expectedVersion: agg.app.version, app: next, documentsUpsert: [], documentsDelete: [documentId], history: null, events: [] });
    if (res !== "ok") return { kind: "conflict" };
    await this.d.store.delete(doc.objectKey);
    return ok(true);
  }

  /** Called by the scanner callback when a verdict was `pending` at confirm time. */
  async applyScanVerdict(objectKey: string, applicationId: string, verdict: "clean" | "infected" | "error"): Promise<boolean> {
    const agg = await this.d.repo.get(applicationId, { kind: "system" });
    const doc = agg?.documents.find((d) => d.objectKey === objectKey);
    if (agg === null || doc === undefined) return false;
    const next: ApplicationRow = { ...agg.app, version: agg.app.version + 1, updatedAtMs: this.d.clock.nowMs() };
    const res = await this.commit({ scope: { kind: "system" }, expectedVersion: agg.app.version, app: next, documentsUpsert: [{ ...doc, scanStatus: verdict }], documentsDelete: [], history: null, events: [] });
    if (verdict === "infected") await this.d.store.delete(objectKey);
    return res === "ok";
  }

}

export type { RequestedItem };
