/**
 * Brand application flow (docs/specs/brand-onboarding.md). Pure view-model logic, types and the port interfaces.
 * Screens stay thin; everything testable lives here (no RN renderer in tests).
 */
import { z } from "zod";

export type BrandKind = "local" | "global";
export type Lang = "ar" | "en";
export interface Bi { readonly ar: string; readonly en: string }
export const pickBi = (b: Bi, lang: Lang): string => (lang === "ar" ? b.ar : b.en);

export type AppStatus = "DRAFT" | "SUBMITTED" | "AUTO_CHECKS" | "IN_REVIEW" | "NEEDS_INFO" | "APPROVED" | "REJECTED" | "SUSPENDED" | "WITHDRAWN";
export type AllowedAction = "edit" | "submit" | "resubmit" | "withdraw" | "appeal" | "upload_document" | "verify_domain";
export type FieldFormat = "text" | "national_id" | "commercial_register_no" | "tax_card_no" | "company_reg_no" | "vat_id" | "url" | "domain" | "handle" | "phone" | "email" | "country" | "date";
export type FileType = "pdf" | "jpg" | "png";

export interface ReqField { readonly code: string; readonly label: Bi; readonly required: boolean; readonly format: FieldFormat; readonly pattern?: string | undefined; readonly minSignatoryAge?: number | undefined }
export interface ReqDoc { readonly code: string; readonly label: Bi; readonly required: boolean; readonly group?: string | undefined; readonly accepts: readonly FileType[]; readonly maxBytes: number; readonly help?: Bi | undefined }
export interface Requirements {
  readonly kind: BrandKind; readonly country: string; readonly version: number;
  readonly fields: readonly ReqField[]; readonly documents: readonly ReqDoc[];
  readonly websiteVerification: "required_if_website" | "required" | "optional";
}

export type ScanStatus = "pending" | "clean" | "infected" | "error";
export type ReviewStatus = "unreviewed" | "accepted" | "rejected" | "unreadable";
export interface DocView {
  readonly id: string; readonly requirementCode: string; readonly contentType: string; readonly sizeBytes: number;
  readonly uploadStatus: "awaiting_upload" | "uploaded" | "expired"; readonly scanStatus: ScanStatus; readonly reviewStatus: ReviewStatus;
  readonly reviewNote?: string | undefined;
}
export interface RequestedItem { readonly code: string; readonly kind: "document" | "field" | "domain_verification" | "clarification"; readonly message: Bi; readonly satisfied: boolean }
export type ReasonCode = "ok" | "ownership_not_proven" | "documents_unreadable" | "documents_inconsistent" | "identity_mismatch" | "domain_not_verified" | "trademark_owner_mismatch" | "not_a_brand" | "prohibited_category" | "counterfeit_confirmed" | "sanctions_hit" | "duplicate_claim" | "incomplete_information" | "other";
export interface Decision { readonly decision: "approved" | "rejected" | "needs_info"; readonly reasonCode: ReasonCode; readonly message: Bi; readonly decidedAt: string; readonly reapplyAfter: string | null; readonly appealAllowed: boolean }
export interface DomainState {
  readonly method: "dns_txt" | "email"; readonly domain: string; readonly status: "pending" | "verified" | "failed" | "expired";
  readonly txtName?: string | undefined; readonly txtValue?: string | undefined; readonly emailMasked?: string | undefined; readonly expiresAt?: string | undefined;
}
export interface ApplicationView {
  readonly id: string; readonly status: AppStatus; readonly kind: BrandKind; readonly country: string; readonly brandName: string;
  /** Form values by requirement field code (the adapter maps the wire record to and from these). */
  readonly values: Readonly<Record<string, string>>;
  readonly ownershipBasis?: string | undefined;
  readonly documents: readonly DocView[]; readonly requestedItems: readonly RequestedItem[];
  readonly decision: Decision | null; readonly decisionDueAt: string | null; readonly domain: DomainState | null;
  readonly allowedActions: readonly AllowedAction[]; readonly appealUsed: boolean; readonly submittedAt: string | null; readonly storeId: string | null;
  readonly version: string | null;
}

export type ErrorCode =
  | "offline" | "failed" | "session_expired" | "invalid_code" | "rate_limited" | "strong_factor_required" | "checklist_incomplete"
  | "reapply_cooldown" | "country_not_supported" | "invalid_transition" | "conflict" | "unsupported" | "document_rejected" | "not_found";
export class BrandApplyError extends Error {
  constructor(readonly code: ErrorCode, readonly detail?: string) { super(code); this.name = "BrandApplyError"; }
}
export const errorCodeOf = (e: unknown): ErrorCode => (e instanceof BrandApplyError ? e.code : "failed");

export interface OtpChallenge { readonly challengeId: string; readonly expiresIn: number; readonly resendAfter: number }
export interface TotpEnrolment { readonly otpauthUri: string; readonly secret: string; readonly recoveryCodes: readonly string[] }
export interface PasskeyChallenge { readonly challengeId: string; readonly publicKey: Readonly<Record<string, unknown>> }
export interface ApplicationPatch { readonly brandName?: string; readonly values?: Readonly<Record<string, string>>; readonly ownershipBasis?: string }
export interface UploadRequest {
  readonly requirementCode: string; readonly contentType: string; readonly sizeBytes: number; readonly uri: string;
  /** Local label only. Never logged, never put in a URL. */
  readonly filename?: string | undefined;
}

export interface BrandApplyPort {
  requestOtp(i: { phone: string; email: string; locale: Lang }): Promise<OtpChallenge>;
  verifyOtp(i: { challengeId: string; code: string }): Promise<{ strongFactorEnrolled: boolean }>;
  getRequirements(kind: BrandKind, country: string): Promise<Requirements>;
  passkeyOptions(): Promise<PasskeyChallenge>;
  passkeyRegister(i: { challengeId: string; credential: Readonly<Record<string, unknown>> }): Promise<void>;
  totpEnrol(): Promise<TotpEnrolment>;
  totpConfirm(code: string): Promise<void>;
  /** Returning brand (strong factor already enrolled): sign back in with the authenticator code. */
  totpAssert(code: string): Promise<void>;
  createApplication(i: { kind: BrandKind; country: string; brandName: string }): Promise<ApplicationView>;
  getApplication(id: string): Promise<ApplicationView>;
  listMine(): Promise<readonly ApplicationView[]>;
  updateApplication(id: string, patch: ApplicationPatch, version: string | null): Promise<ApplicationView>;
  uploadDocument(id: string, req: UploadRequest, onProgress: (ratio: number) => void): Promise<DocView>;
  deleteDocument(id: string, docId: string): Promise<void>;
  startDomain(id: string, method: "dns_txt" | "email"): Promise<DomainState>;
  confirmDomain(id: string, code?: string): Promise<DomainState>;
  submit(id: string): Promise<ApplicationView>;
  resubmit(id: string, i: { note?: string; satisfiedCodes: readonly string[] }): Promise<ApplicationView>;
  appeal(id: string, statement: string): Promise<ApplicationView>;
  withdraw(id: string): Promise<ApplicationView>;
}

export interface PasskeyPort {
  isSupported(): Promise<boolean>;
  /** Creates a credential for the server options. Throws BrandApplyError("unsupported") on a build without passkeys. */
  create(options: Readonly<Record<string, unknown>>): Promise<Readonly<Record<string, unknown>>>;
}

export interface PickedFile { readonly uri: string; readonly mimeType: string; readonly sizeBytes: number; readonly name?: string | undefined }
export type PickSource = "camera" | "library" | "files" | "sample";
export interface FilePickerPort { pick(source: PickSource): Promise<PickedFile | null> }

/* ------------------------------------------------------------------ steps and resumability */

export const STEPS = ["type", "country", "account", "factor", "details", "documents", "website", "review"] as const;
export type Step = (typeof STEPS)[number];
export const stepIndex = (s: Step): number => STEPS.indexOf(s);

export const PersistedDraft = z.object({
  draftId: z.string().min(8).max(64).nullable(),
  kind: z.enum(["local", "global"]).nullable(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable(),
  brandName: z.string().max(80).nullable(),
  step: z.enum(STEPS),
});
export type PersistedDraft = z.infer<typeof PersistedDraft>;
export const EMPTY_DRAFT: PersistedDraft = { draftId: null, kind: null, country: null, brandName: null, step: "type" };
export const DRAFT_STORAGE_KEY = "brand.apply.draft";

export function parseDraft(raw: string | null): PersistedDraft {
  if (raw === null) return EMPTY_DRAFT;
  try { const r = PersistedDraft.safeParse(JSON.parse(raw)); return r.success ? r.data : EMPTY_DRAFT; } catch { return EMPTY_DRAFT; }
}

/** Furthest step a draft may resume at: never ahead of what the data supports. */
export function maxResumableStep(d: PersistedDraft, hasStrongFactor: boolean): Step {
  if (d.kind === null) return "type";
  if (d.country === null) return "country";
  if (d.draftId === null) return hasStrongFactor ? "details" : "account";
  return "review";
}

export type ResumeTarget = { readonly route: "status" } | { readonly route: "step"; readonly step: Step };
/** Where the app reopens: status once past DRAFT, else the saved step clamped to what exists. */
export function resumeTarget(d: PersistedDraft, app: Pick<ApplicationView, "status"> | null, hasStrongFactor: boolean): ResumeTarget {
  if (app !== null && app.status !== "DRAFT") return { route: "status" };
  const cap = stepIndex(maxResumableStep(d, hasStrongFactor));
  // Steps that need a server session fall back to account sign-in when the session is gone.
  let idx = Math.min(stepIndex(d.step), cap);
  if (idx > stepIndex("factor") && !hasStrongFactor && d.draftId === null) idx = stepIndex("account");
  return { route: "step", step: STEPS[Math.max(0, idx)] ?? "type" };
}

/** The steps shown for these requirements: the website step is dropped when nothing asks for it. */
export function stepsFor(req: Requirements | null, hasDomain: boolean): readonly Step[] {
  const skipWebsite = req !== null && req.websiteVerification === "optional" && !hasDomain;
  return STEPS.filter((s) => !(s === "website" && skipWebsite));
}
export function nextStep(current: Step, steps: readonly Step[]): Step {
  const i = steps.indexOf(current);
  return steps[Math.min(steps.length - 1, i + 1)] ?? current;
}
export function stepProgress(current: Step, steps: readonly Step[]): { readonly index: number; readonly total: number } {
  return { index: Math.max(0, steps.indexOf(current)) + 1, total: steps.length };
}

/* ------------------------------------------------------------------ validation */

export type FieldError =
  | "required" | "too_short" | "too_long" | "invalid_phone" | "invalid_email" | "invalid_format" | "invalid_domain" | "domain_not_allowed"
  | "invalid_date" | "signatory_too_young" | "invalid_code";

const AR_INDIC = "٠١٢٣٤٥٦٧٨٩";
const FA_INDIC = "۰۱۲۳۴۵۶۷۸۹";
export function toLatinDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => String(AR_INDIC.indexOf(c) >= 0 ? AR_INDIC.indexOf(c) : FA_INDIC.indexOf(c)));
}

/** Egyptian mobile shorthand (01xxxxxxxxx) and 00-prefixed numbers become E.164; other input must already be +. */
export function normalizePhone(raw: string, defaultDial = "+20"): string {
  const s = toLatinDigits(raw).replace(/[\s\-().]/g, "");
  if (s.startsWith("+")) return s;
  if (s.startsWith("00")) return `+${s.slice(2)}`;
  if (s.startsWith("0")) return `${defaultDial}${s.slice(1)}`;
  return s;
}
export const isE164 = (s: string): boolean => /^\+[1-9][0-9]{7,14}$/.test(s);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const isEmail = (s: string): boolean => s.length <= 254 && EMAIL.test(s);

const BLOCKED_DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "instagram.com", "facebook.com", "tiktok.com", "linktr.ee", "wa.me", "t.me"];
/** Lower-cases and strips scheme, www and path: the server wants a bare registrable domain. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
}
export function validateDomain(raw: string): FieldError | null {
  const d = normalizeDomain(raw);
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) return "invalid_domain";
  if (BLOCKED_DOMAINS.some((b) => d === b || d.endsWith(`.${b}`))) return "domain_not_allowed";
  return null;
}
export const normalizeHandle = (raw: string): string => raw.trim().replace(/^@/, "");

export interface AccountInput { readonly brandName: string; readonly phone: string; readonly email: string }
export type AccountErrors = Partial<Record<keyof AccountInput, FieldError>>;
export function validateAccount(i: AccountInput): AccountErrors {
  const e: { -readonly [K in keyof AccountInput]?: FieldError } = {};
  const name = i.brandName.trim();
  if (name.length === 0) e.brandName = "required";
  else if (name.length < 2) e.brandName = "too_short";
  else if (name.length > 80) e.brandName = "too_long";
  if (i.phone.trim().length === 0) e.phone = "required";
  else if (!isE164(normalizePhone(i.phone))) e.phone = "invalid_phone";
  if (i.email.trim().length === 0) e.email = "required";
  else if (!isEmail(i.email.trim())) e.email = "invalid_email";
  return e;
}
export const isValidOtp = (code: string): boolean => /^[0-9]{6}$/.test(toLatinDigits(code).trim());

function plausibleDate(v: string): { ok: boolean; age: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m === null) return { ok: false, age: 0 };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return { ok: false, age: 0 };
  const now = new Date();
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age -= 1;
  return { ok: age >= 0 && age < 120, age };
}

const FORMAT_PATTERNS: Partial<Record<FieldFormat, RegExp>> = {
  national_id: /^[0-9]{14}$/,
  commercial_register_no: /^[0-9A-Za-z/-]{4,20}$/,
  tax_card_no: /^[0-9]{3}-?[0-9]{3}-?[0-9]{3}$/,
  company_reg_no: /^[0-9A-Za-z/\- ]{4,30}$/,
  vat_id: /^[0-9A-Za-z\-. ]{4,20}$/,
  handle: /^[A-Za-z0-9._]{1,60}$/,
};

export function validateField(f: ReqField, rawValue: string): FieldError | null {
  const value = toLatinDigits(rawValue).trim();
  if (value.length === 0) return f.required ? "required" : null;
  if (rawValue.length > 200 && f.format === "text") return "too_long";
  switch (f.format) {
    case "text": return value.length < 2 ? "too_short" : null;
    case "phone": return isE164(normalizePhone(value)) ? null : "invalid_phone";
    case "email": return isEmail(value) ? null : "invalid_email";
    case "domain": return validateDomain(value);
    case "url": return validateDomain(value);
    case "country": return /^[A-Z]{2}$/.test(value.toUpperCase()) ? null : "invalid_format";
    case "date": {
      const d = plausibleDate(value);
      if (!d.ok) return "invalid_date";
      return f.minSignatoryAge !== undefined && d.age < f.minSignatoryAge ? "signatory_too_young" : null;
    }
    default: {
      if (f.pattern !== undefined) {
        try { if (!new RegExp(f.pattern).test(value)) return "invalid_format"; } catch { /* a bad server pattern must not block the user: fall back to the format */ }
      }
      const re = FORMAT_PATTERNS[f.format];
      return re !== undefined && !re.test(f.format === "handle" ? normalizeHandle(value) : value) ? "invalid_format" : null;
    }
  }
}

/** Normalises a value before sending (digits, domain, handle). */
export function normalizeFieldValue(f: ReqField, raw: string): string {
  const v = raw.trim();
  switch (f.format) {
    case "domain": case "url": return normalizeDomain(v);
    case "handle": return normalizeHandle(v);
    case "phone": return normalizePhone(v);
    case "national_id": case "tax_card_no": case "commercial_register_no": case "date": return toLatinDigits(v);
    default: return v;
  }
}

export function validateDetails(fields: readonly ReqField[], values: Readonly<Record<string, string>>): Readonly<Record<string, FieldError>> {
  const out: Record<string, FieldError> = {};
  for (const f of fields) { const e = validateField(f, values[f.code] ?? ""); if (e !== null) out[f.code] = e; }
  return out;
}
export const detailsComplete = (fields: readonly ReqField[], values: Readonly<Record<string, string>>): boolean =>
  Object.keys(validateDetails(fields, values)).length === 0;

/* ------------------------------------------------------------------ files */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_DOCUMENTS = 20;
const MIME_BY_TYPE: Record<FileType, readonly string[]> = { pdf: ["application/pdf"], jpg: ["image/jpeg", "image/jpg"], png: ["image/png"] };

export type FileError = "type" | "size" | "empty";
export function validateFile(f: { mimeType: string; sizeBytes: number }, accepts: readonly FileType[], maxBytes = MAX_UPLOAD_BYTES): FileError | null {
  const mime = f.mimeType.toLowerCase();
  if (!accepts.some((t) => MIME_BY_TYPE[t].includes(mime))) return "type";
  if (f.sizeBytes <= 0) return "empty";
  if (f.sizeBytes > Math.min(maxBytes, MAX_UPLOAD_BYTES)) return "size";
  return null;
}
/** The wire content type for a validated mime (image/jpg is normalised). */
export const wireContentType = (mime: string): "application/pdf" | "image/jpeg" | "image/png" => {
  const m = mime.toLowerCase();
  return m === "application/pdf" ? "application/pdf" : m === "image/png" ? "image/png" : "image/jpeg";
};

/* ------------------------------------------------------------------ document slot state machine */

export type SlotFailure = "type" | "size" | "empty" | "network" | "server";
export type SlotState =
  | { readonly kind: "missing" }
  | { readonly kind: "uploading"; readonly progress: number }
  | { readonly kind: "failed"; readonly reason: SlotFailure; readonly retryable: boolean }
  | { readonly kind: "uploaded" }
  | { readonly kind: "scanning" }
  | { readonly kind: "accepted" }
  | { readonly kind: "rejected"; readonly reason: "infected" | "unreadable" | "rejected"; readonly note?: string | undefined }
  | { readonly kind: "needs_replacement" };

export type SlotEvent =
  | { readonly t: "start" }
  | { readonly t: "progress"; readonly ratio: number }
  | { readonly t: "done" }
  | { readonly t: "fail"; readonly reason: SlotFailure }
  | { readonly t: "server"; readonly doc: DocView }
  | { readonly t: "remove" };

export function slotFromServer(d: DocView): SlotState {
  if (d.uploadStatus === "expired" || d.uploadStatus === "awaiting_upload") return { kind: "needs_replacement" };
  if (d.scanStatus === "infected") return { kind: "rejected", reason: "infected" };
  if (d.scanStatus === "error") return { kind: "needs_replacement" };
  if (d.scanStatus === "pending") return { kind: "scanning" };
  if (d.reviewStatus === "accepted") return { kind: "accepted" };
  if (d.reviewStatus === "rejected") return { kind: "rejected", reason: "rejected", note: d.reviewNote };
  if (d.reviewStatus === "unreadable") return { kind: "rejected", reason: "unreadable", note: d.reviewNote };
  return { kind: "uploaded" };
}

/** A new upload may start unless one is already in flight or being scanned (no double upload). */
export const canStartUpload = (s: SlotState): boolean => s.kind !== "uploading" && s.kind !== "scanning";
export const isRetryable = (s: SlotState): boolean => s.kind === "failed" && s.retryable;
export const canDelete = (s: SlotState, editable: boolean): boolean => editable && s.kind !== "missing" && s.kind !== "uploading";
/** Counts toward a complete checklist: received by the server and not refused. */
export const slotSatisfied = (s: SlotState): boolean => s.kind === "uploaded" || s.kind === "scanning" || s.kind === "accepted";

export function slotReducer(s: SlotState, e: SlotEvent): SlotState {
  switch (e.t) {
    case "start": return canStartUpload(s) ? { kind: "uploading", progress: 0 } : s;
    case "progress": return s.kind === "uploading" ? { kind: "uploading", progress: Math.max(s.progress, Math.min(1, Math.max(0, e.ratio))) } : s;
    case "done": return s.kind === "uploading" ? { kind: "uploaded" } : s;
    case "fail": return s.kind === "uploading" || s.kind === "missing" || s.kind === "failed" || s.kind === "needs_replacement" || s.kind === "rejected"
      ? { kind: "failed", reason: e.reason, retryable: e.reason === "network" || e.reason === "server" } : s;
    case "server": return s.kind === "uploading" ? s : slotFromServer(e.doc);
    case "remove": return s.kind === "uploading" ? s : { kind: "missing" };
  }
}

export interface ChecklistItem { readonly doc: ReqDoc; readonly state: SlotState; readonly satisfied: boolean }
export interface Checklist { readonly items: readonly ChecklistItem[]; readonly complete: boolean; readonly missing: readonly string[] }

/** Documents in a `group` are alternatives: the group is satisfied by any one member and required if any member is. */
export function buildChecklist(docs: readonly ReqDoc[], slots: Readonly<Record<string, SlotState>>): Checklist {
  const stateOf = (c: string): SlotState => slots[c] ?? { kind: "missing" };
  const groups = new Map<string, ReqDoc[]>();
  for (const d of docs) if (d.group !== undefined) groups.set(d.group, [...(groups.get(d.group) ?? []), d]);
  const missing: string[] = [];
  const items = docs.map((doc): ChecklistItem => {
    const state = stateOf(doc.code);
    const members = doc.group !== undefined ? (groups.get(doc.group) ?? [doc]) : [doc];
    const satisfied = members.some((m) => slotSatisfied(stateOf(m.code)));
    return { doc, state, satisfied };
  });
  const seen = new Set<string>();
  for (const it of items) {
    const g = it.doc.group;
    if (g !== undefined) {
      if (seen.has(g)) continue;
      seen.add(g);
      const members = groups.get(g) ?? [];
      if (members.some((m) => m.required) && !it.satisfied) missing.push(g);
    } else if (it.doc.required && !it.satisfied) missing.push(it.doc.code);
  }
  return { items, complete: missing.length === 0, missing };
}

/* ------------------------------------------------------------------ review and submit */

export type SubmitBlocker = "no_strong_factor" | "details_incomplete" | "documents_incomplete" | "domain_unverified" | "not_declared";
export function submitBlockers(i: { strongFactor: boolean; detailsOk: boolean; checklistComplete: boolean; domainRequired: boolean; domainVerified: boolean; declared: boolean }): readonly SubmitBlocker[] {
  const b: SubmitBlocker[] = [];
  if (!i.strongFactor) b.push("no_strong_factor");
  if (!i.detailsOk) b.push("details_incomplete");
  if (!i.checklistComplete) b.push("documents_incomplete");
  if (i.domainRequired && !i.domainVerified) b.push("domain_unverified");
  if (!i.declared) b.push("not_declared");
  return b;
}
export function domainRequired(req: Requirements | null, domain: string): boolean {
  if (req === null) return false;
  return req.websiteVerification === "required" || (req.websiteVerification === "required_if_website" && domain.trim().length > 0);
}

/* ------------------------------------------------------------------ status timeline */

export type TimelineKey = "submitted" | "checks" | "review" | "decision";
export type TimelineState = "done" | "current" | "upcoming";
export type StatusPhase = "draft" | "in_progress" | "needs_info" | "approved" | "rejected" | "suspended" | "withdrawn";
export interface TimelineView { readonly phase: StatusPhase; readonly steps: readonly { readonly key: TimelineKey; readonly state: TimelineState }[] }

export function timeline(status: AppStatus): TimelineView {
  const mk = (states: readonly [TimelineState, TimelineState, TimelineState, TimelineState], phase: StatusPhase): TimelineView => ({
    phase, steps: (["submitted", "checks", "review", "decision"] as const).map((key, i) => ({ key, state: states[i] ?? "upcoming" })),
  });
  switch (status) {
    case "DRAFT": return mk(["upcoming", "upcoming", "upcoming", "upcoming"], "draft");
    case "SUBMITTED": return mk(["done", "current", "upcoming", "upcoming"], "in_progress");
    case "AUTO_CHECKS": return mk(["done", "current", "upcoming", "upcoming"], "in_progress");
    case "IN_REVIEW": return mk(["done", "done", "current", "upcoming"], "in_progress");
    case "NEEDS_INFO": return mk(["done", "done", "done", "current"], "needs_info");
    case "APPROVED": return mk(["done", "done", "done", "done"], "approved");
    case "REJECTED": return mk(["done", "done", "done", "done"], "rejected");
    case "SUSPENDED": return mk(["done", "done", "done", "done"], "suspended");
    case "WITHDRAWN": return mk(["upcoming", "upcoming", "upcoming", "upcoming"], "withdrawn");
  }
}

export type ExpectedTime = { readonly kind: "due"; readonly iso: string } | { readonly kind: "overdue" } | { readonly kind: "none" };
/** Honest expected time: only the server's `decision_due_at`, never invented. Past due says so. */
export function expectedTime(app: Pick<ApplicationView, "status" | "decisionDueAt">, nowMs: number): ExpectedTime {
  if (!(app.status === "SUBMITTED" || app.status === "AUTO_CHECKS" || app.status === "IN_REVIEW") || app.decisionDueAt === null) return { kind: "none" };
  const due = Date.parse(app.decisionDueAt);
  if (Number.isNaN(due)) return { kind: "none" };
  return due < nowMs ? { kind: "overdue" } : { kind: "due", iso: app.decisionDueAt };
}

export const APPEAL_WINDOW_DAYS = 30;
const DAY = 86_400_000;
export interface RejectionView { readonly canAppeal: boolean; readonly appealUntil: string | null; readonly canReapplyNow: boolean; readonly reapplyAfter: string | null }
export function rejectionView(app: Pick<ApplicationView, "decision" | "allowedActions" | "appealUsed">, nowMs: number): RejectionView {
  const d = app.decision;
  if (d === null) return { canAppeal: false, appealUntil: null, canReapplyNow: true, reapplyAfter: null };
  const until = Date.parse(d.decidedAt) + APPEAL_WINDOW_DAYS * DAY;
  const inWindow = !Number.isNaN(until) && nowMs <= until;
  const reapply = d.reapplyAfter !== null && d.reapplyAfter !== undefined ? Date.parse(d.reapplyAfter) : null;
  return {
    canAppeal: !app.appealUsed && d.appealAllowed && inWindow && app.allowedActions.includes("appeal"),
    appealUntil: Number.isNaN(until) ? null : new Date(until).toISOString(),
    canReapplyNow: reapply === null || Number.isNaN(reapply) || reapply <= nowMs,
    reapplyAfter: d.reapplyAfter,
  };
}
export const validAppealStatement = (s: string): boolean => s.trim().length >= 20 && s.trim().length <= 2000;

/** NEEDS_INFO: every requested item must be addressed locally (uploaded / edited / verified) before resubmit. */
export function resubmitReady(items: readonly RequestedItem[], addressed: ReadonlySet<string>): boolean {
  return items.length > 0 ? items.every((i) => i.satisfied || addressed.has(i.code)) : true;
}
export const unaddressedItems = (items: readonly RequestedItem[], addressed: ReadonlySet<string>): readonly RequestedItem[] =>
  items.filter((i) => !i.satisfied && !addressed.has(i.code));

/** Statuses a brand user sees the status screen for (the home of the brand user until approved). */
export const isPostSubmit = (s: AppStatus): boolean => s !== "DRAFT";
export const canOpenDashboard = (a: Pick<ApplicationView, "status" | "storeId">): boolean => a.status === "APPROVED";
export const isEditable = (a: Pick<ApplicationView, "allowedActions">): boolean => a.allowedActions.includes("edit");

/* ------------------------------------------------------------------ autosave */

/** Which values differ from the last saved snapshot (only these are sent). */
export function dirtyValues(saved: Readonly<Record<string, string>>, current: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(current)) if ((saved[k] ?? "") !== v) out[k] = v;
  return out;
}
