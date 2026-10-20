import {
  BRAND_REASON_CODES, BRAND_STATUSES, CONFLICT_OUTCOMES,
  type AdminBrandApplicationWire, type AutoCheckWire, type BrandApplicationWire, type BrandDocumentWire, type BrandKind,
  type BrandQueueItemWire, type BrandReasonCode, type BrandStatus, type ConflictOutcome, type RequestedItemWire,
  type TrademarkEvidenceWire,
} from "../api/brand-schemas";
import { countdown, type Countdown } from "../lib/format";
import type { MessageKey } from "../i18n";
import type { Role } from "./common";

/* ------------------------------------------------------------------ queue filters -> query */

export type AssigneeFilter = "me" | "unassigned" | "any";
export interface QueueFilters {
  readonly status?: BrandStatus;
  readonly kind?: BrandKind;
  readonly country?: string;
  readonly assignee?: AssigneeFilter;
  readonly slaBreached?: boolean;
  readonly cursor?: string;
}
type Raw = Readonly<Record<string, string | readonly string[] | undefined>>;
const first = (v: string | readonly string[] | undefined): string | undefined => (typeof v === "string" ? v : v?.[0]);

/** Reads URL search params. Anything not in the enumerations is dropped, never forwarded to the API. */
export function parseQueueFilters(sp: Raw): QueueFilters {
  const status = first(sp.status);
  const kind = first(sp.kind);
  const country = first(sp.country)?.trim().toUpperCase();
  const assignee = first(sp.assignee);
  const cursor = first(sp.cursor);
  return {
    ...(status !== undefined && (BRAND_STATUSES as readonly string[]).includes(status) ? { status: status as BrandStatus } : {}),
    ...(kind === "local" || kind === "global" ? { kind } : {}),
    ...(country !== undefined && /^[A-Z]{2}$/.test(country) ? { country } : {}),
    ...(assignee === "me" || assignee === "unassigned" || assignee === "any" ? { assignee } : {}),
    ...(first(sp.sla_breached) === "true" ? { slaBreached: true } : {}),
    ...(cursor !== undefined && cursor.length > 0 && cursor.length <= 512 ? { cursor } : {}),
  };
}

/** Filters to the API query (sla_breached only sent when true: "false" would mean "not breached" and hide the rest). */
export function queueApiQuery(f: QueueFilters): {
  status?: BrandStatus; kind?: BrandKind; country?: string; assignee?: AssigneeFilter; sla_breached?: boolean; cursor?: string;
} {
  return {
    ...(f.status === undefined ? {} : { status: f.status }),
    ...(f.kind === undefined ? {} : { kind: f.kind }),
    ...(f.country === undefined ? {} : { country: f.country }),
    ...(f.assignee === undefined ? {} : { assignee: f.assignee }),
    ...(f.slaBreached === true ? { sla_breached: true } : {}),
    ...(f.cursor === undefined ? {} : { cursor: f.cursor }),
  };
}

/** Filters to a stable URL query string (no cursor unless asked), so every view is linkable. */
export function queueSearch(f: QueueFilters, cursor?: string): string {
  const p = new URLSearchParams();
  if (f.status !== undefined) p.set("status", f.status);
  if (f.kind !== undefined) p.set("kind", f.kind);
  if (f.country !== undefined) p.set("country", f.country);
  if (f.assignee !== undefined) p.set("assignee", f.assignee);
  if (f.slaBreached === true) p.set("sla_breached", "true");
  if (cursor !== undefined) p.set("cursor", cursor);
  const s = p.toString();
  return s === "" ? "" : `?${s}`;
}

/** The "review work" statuses the queue defaults to when no status is chosen. */
export const OPEN_STATUSES: readonly BrandStatus[] = ["SUBMITTED", "AUTO_CHECKS", "IN_REVIEW", "NEEDS_INFO"];

/* ------------------------------------------------------------------ rows, SLA, risk */

export type RiskBand = "low" | "medium" | "high" | "unknown";
/** Bands over the auto-check risk_score (0-100). Thresholds are a console presentation default, the score is the server's. */
export function riskBand(score: number | undefined): RiskBand {
  if (score === undefined) return "unknown";
  return score >= 70 ? "high" : score >= 30 ? "medium" : "low";
}
export function riskScoreOf(checks: readonly AutoCheckWire[]): number | undefined {
  const c = checks.find((x) => x.code === "risk_score");
  if (c?.detail === undefined) return undefined;
  const m = /\d{1,3}/.exec(c.detail);
  const n = m === null ? NaN : Number(m[0]);
  return Number.isInteger(n) && n >= 0 && n <= 100 ? n : undefined;
}

export interface SlaView {
  readonly clock: Countdown | null;
  readonly breached: boolean;
  /** 0..1 of the window (submitted -> due) consumed, from the SERVER clock. */
  readonly elapsed: number;
}
const TERMINAL: readonly BrandStatus[] = ["APPROVED", "REJECTED", "WITHDRAWN", "DRAFT"];
export function slaView(p: { status: BrandStatus; submittedAtIso: string | null; dueAtIso: string; serverBreached?: boolean }, serverNowMs: number): SlaView {
  const due = Date.parse(p.dueAtIso);
  if (TERMINAL.includes(p.status) || Number.isNaN(due)) return { clock: null, breached: false, elapsed: 1 };
  const start = p.submittedAtIso === null ? NaN : Date.parse(p.submittedAtIso);
  const span = Number.isNaN(start) ? 1 : Math.max(1, due - start);
  const breached = p.serverBreached === true || serverNowMs > due;
  return {
    clock: countdown(due, serverNowMs),
    breached,
    elapsed: Number.isNaN(start) ? (breached ? 1 : 0) : Math.min(1, Math.max(0, (serverNowMs - start) / span)),
  };
}

export interface QueueRow {
  readonly id: string;
  readonly brandName: string;
  readonly kind: BrandKind;
  readonly country: string;
  readonly status: BrandStatus;
  readonly assignedToMe: boolean;
  readonly unassigned: boolean;
  readonly sla: SlaView;
  readonly risk: RiskBand;
  readonly riskScore: number | null;
  readonly appeal: boolean;
  readonly highRiskCountry: boolean;
  readonly dueAtMs: number;
}
export function queueRow(i: BrandQueueItemWire, serverNowMs: number, selfId: string | null): QueueRow {
  return {
    id: i.id,
    brandName: i.brand_name,
    kind: i.brand_kind,
    country: i.country,
    status: i.status,
    assignedToMe: selfId !== null && i.assignee_id === selfId,
    unassigned: i.assignee_id === null || i.assignee_id === undefined,
    sla: slaView({ status: i.status, submittedAtIso: i.submitted_at, dueAtIso: i.decision_due_at, ...(i.sla_breached === undefined ? {} : { serverBreached: i.sla_breached }) }, serverNowMs),
    risk: riskBand(i.risk_score),
    riskScore: i.risk_score ?? null,
    appeal: i.appeal === true,
    highRiskCountry: i.high_risk_country === true,
    dueAtMs: Date.parse(i.decision_due_at),
  };
}
/** Breached first, then soonest due (the API already sorts oldest-due first; this keeps a stable order after merges). */
export function queueRows(items: readonly BrandQueueItemWire[], serverNowMs: number, selfId: string | null): readonly QueueRow[] {
  return items
    .map((i) => queueRow(i, serverNowMs, selfId))
    .sort((a, b) => Number(b.sla.breached) - Number(a.sla.breached) || a.dueAtMs - b.dueAtMs || a.id.localeCompare(b.id));
}

/** Overview tile text: a capped fetch cannot know the true total, so it says "50+" instead of lying. */
export function countLabel(n: number, hasMore: boolean): string {
  return hasMore ? `${n}+` : String(n);
}

/* ------------------------------------------------------------------ action availability */

export const REVIEW_ROLES: readonly Role[] = ["ops", "trust_safety", "super_admin"];
export const CONFLICT_ROLES: readonly Role[] = ["trust_safety", "super_admin"];
const CLAIMABLE: readonly BrandStatus[] = ["SUBMITTED", "AUTO_CHECKS", "IN_REVIEW"];

export interface Gate {
  readonly allowed: boolean;
  /** Why it is off (shown as helper text). null when allowed. */
  readonly reasonKey: MessageKey | null;
}
const yes: Gate = { allowed: true, reasonKey: null };
const no = (reasonKey: MessageKey): Gate => ({ allowed: false, reasonKey });

export interface ActionContext {
  readonly status: BrandStatus;
  readonly assigneeId: string | null;
  readonly selfId: string | null;
  /** null = the server did not tell us: show everything and let the API decide. */
  readonly roles: readonly Role[] | null;
  readonly pendingCosign: boolean;
  readonly duplicateCount: number;
  readonly postureWritesEnabled: boolean;
}
export interface Availability {
  readonly claim: Gate; readonly release: Gate; readonly approve: Gate; readonly reject: Gate; readonly needsInfo: Gate;
  readonly cosign: Gate; readonly readDocuments: Gate; readonly trademarkLookup: Gate; readonly resolveConflict: Gate;
}
const hasRole = (roles: readonly Role[] | null, allowed: readonly Role[]): boolean => roles === null || allowed.some((r) => roles.includes(r));

/**
 * What the console OFFERS. It is a convenience: the API re-checks role, assignee, applicant link, JIT elevation and
 * state on every call and its 403/409 are rendered as states. Never treat this as authorization.
 */
export function availability(c: ActionContext): Availability {
  const reviewer = hasRole(c.roles, REVIEW_ROLES);
  const mine = c.selfId !== null && c.assigneeId === c.selfId;
  const base = !reviewer ? no("brand.gate.role") : !c.postureWritesEnabled ? no("brand.gate.posture") : yes;
  const decide: Gate = !base.allowed ? base
    : c.status !== "IN_REVIEW" ? no("brand.gate.status")
      : c.assigneeId === null ? no("brand.gate.claimFirst")
        : !mine ? no("brand.gate.notAssignee")
          : c.pendingCosign ? no("brand.gate.awaitingCosign") : yes;
  const claim: Gate = !base.allowed ? base : !CLAIMABLE.includes(c.status) ? no("brand.gate.status") : c.assigneeId !== null ? no("brand.gate.alreadyClaimed") : yes;
  const release: Gate = !base.allowed ? base
    : c.assigneeId === null ? no("brand.gate.notClaimed")
      : !mine && !(c.roles?.includes("super_admin") ?? true) ? no("brand.gate.notAssignee") : yes;
  const cosign: Gate = !base.allowed ? base
    : !c.pendingCosign ? no("brand.gate.noCosign")
      : c.assigneeId !== null && c.assigneeId === c.selfId ? no("brand.gate.cosignSelf") : yes;
  const docs: Gate = !reviewer ? no("brand.gate.role") : !mine ? no("brand.gate.notAssignee") : yes;
  const trademarkLookup: Gate = !base.allowed ? base : c.status !== "IN_REVIEW" ? no("brand.gate.status") : !mine ? no("brand.gate.notAssignee") : yes;
  const resolveConflict: Gate = !hasRole(c.roles, CONFLICT_ROLES) ? no("brand.gate.conflictRole")
    : !c.postureWritesEnabled ? no("brand.gate.posture")
      : c.duplicateCount === 0 ? no("brand.gate.noConflict") : c.status !== "IN_REVIEW" ? no("brand.gate.status") : yes;
  return { claim, release, approve: decide, reject: decide, needsInfo: decide, cosign, readDocuments: docs, trademarkLookup, resolveConflict };
}

/** What approving does, shown verbatim before the confirm. A high-risk global brand only reaches cosign. */
export function approveConsequence(a: { pendingCosignRequired: boolean }): readonly MessageKey[] {
  return a.pendingCosignRequired
    ? ["brand.approve.cosignFirst", "brand.approve.thenCreates"]
    : ["brand.approve.createsStore", "brand.approve.createsOwner", "brand.approve.notifies"];
}
/** Whether an approve will park at cosign rather than provision (high-risk country, global, or any sanctions flag). */
export function approveNeedsCosign(app: AdminBrandApplicationWire): boolean {
  const sanctionsFlag = app.auto_checks.some((c) => c.code === "sanctions_screen" && (c.result === "fail" || c.result === "warn"));
  return (app.application.brand_kind === "global" && app.high_risk_country === true) || sanctionsFlag;
}

/* ------------------------------------------------------------------ decision form validation */

export type DecisionKind = "approve" | "reject" | "needs_info";
export interface DecisionInput {
  readonly decision: string;
  readonly reasonCode: string;
  readonly messageAr: string;
  readonly messageEn: string;
  /** Requested item codes picked in the multi-select, with their kind. */
  readonly items: readonly { readonly code: string; readonly kind: string }[];
  readonly internalNote: string;
  readonly reapplyAfterDays: string;
  readonly slug: string;
}
export type DecisionField = "decision" | "reasonCode" | "messageAr" | "messageEn" | "items" | "internalNote" | "reapplyAfterDays" | "slug";
export type DecisionResult =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly errors: Readonly<Partial<Record<DecisionField, MessageKey>>> };

const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ITEM_KINDS = ["document", "field", "domain_verification", "clarification"];

export function validateDecision(i: DecisionInput): DecisionResult {
  const errors: Partial<Record<DecisionField, MessageKey>> = {};
  const decision = i.decision;
  if (decision !== "approve" && decision !== "reject" && decision !== "needs_info") return { ok: false, errors: { decision: "brand.err.decision" } };
  const reason = (BRAND_REASON_CODES as readonly string[]).includes(i.reasonCode) ? (i.reasonCode as BrandReasonCode) : null;
  const ar = i.messageAr.trim();
  const en = i.messageEn.trim();
  const note = i.internalNote.trim();
  if (reason === null) errors.reasonCode = "brand.err.reason";
  else if (decision === "approve" && reason !== "ok") errors.reasonCode = "brand.err.approveReason";
  else if (decision !== "approve" && reason === "ok") errors.reasonCode = "brand.err.reason";
  if (note.length > 4000) errors.internalNote = "brand.err.tooLong";
  if (decision === "reject" || decision === "needs_info") {
    if (ar === "") errors.messageAr = "brand.err.messageAr";
    else if (!ARABIC.test(ar)) errors.messageAr = "brand.err.messageArScript";
    else if (ar.length > (decision === "reject" ? 1000 : 500)) errors.messageAr = "brand.err.tooLong";
    if (en === "") errors.messageEn = "brand.err.messageEn";
    else if (!LATIN.test(en)) errors.messageEn = "brand.err.messageEnScript";
    else if (en.length > (decision === "reject" ? 1000 : 500)) errors.messageEn = "brand.err.tooLong";
  }
  if (decision === "needs_info") {
    if (i.items.length === 0) errors.items = "brand.err.items";
    else if (i.items.length > 20 || i.items.some((x) => !ITEM_KINDS.includes(x.kind) || x.code.trim() === "")) errors.items = "brand.err.itemsInvalid";
  }
  let reapply: number | null = null;
  if (decision === "reject" && i.reapplyAfterDays.trim() !== "") {
    reapply = /^\d{1,3}$/.test(i.reapplyAfterDays.trim()) ? Number(i.reapplyAfterDays.trim()) : NaN;
    if (!Number.isInteger(reapply) || reapply < 0 || reapply > 365) errors.reapplyAfterDays = "brand.err.reapply";
  }
  const slug = i.slug.trim();
  if (decision === "approve" && slug !== "" && (slug.length > 60 || !SLUG.test(slug))) errors.slug = "brand.err.slug";
  if (Object.keys(errors).length > 0 || reason === null) return { ok: false, errors };
  const body: Record<string, unknown> = { decision, reason_code: reason };
  if (decision === "reject") {
    body.public_message_ar = ar;
    body.public_message_en = en;
    if (reapply !== null) body.reapply_after_days = reapply;
  }
  if (decision === "needs_info") {
    body.requested_items = i.items.map((x) => ({ code: x.code.trim(), kind: x.kind, message_ar: ar, message_en: en }));
  }
  if (decision === "approve" && slug !== "") body.slug = slug;
  if (note !== "") body.internal_note = note;
  return { ok: true, body };
}

export type NoteResult = { readonly ok: true; readonly note: string } | { readonly ok: false; readonly error: MessageKey };
/** Cosign and conflict resolution both require a written internal note (audited). */
export function validateNote(raw: string): NoteResult {
  const note = raw.trim();
  if (note === "") return { ok: false, error: "brand.err.note" };
  if (note.length > 4000) return { ok: false, error: "brand.err.tooLong" };
  return { ok: true, note };
}
export function isConflictOutcome(v: string): v is ConflictOutcome {
  return (CONFLICT_OUTCOMES as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ requirements checklist + documents */

export type DocState = "missing" | "scanning" | "blocked" | "to_review" | "accepted" | "rejected";
export function documentState(d: BrandDocumentWire): DocState {
  if (d.upload_status !== "uploaded") return "missing";
  if (d.scan_status === "pending") return "scanning";
  if (d.scan_status !== "clean") return "blocked";
  if (d.review_status === "accepted") return "accepted";
  if (d.review_status === "rejected" || d.review_status === "unreadable") return "rejected";
  return "to_review";
}
/** The API only issues read URLs for clean-scanned, uploaded documents. */
export const isViewable = (d: BrandDocumentWire): boolean => d.upload_status === "uploaded" && d.scan_status === "clean";

export interface ChecklistRow {
  readonly code: string;
  readonly documents: readonly { readonly doc: BrandDocumentWire; readonly state: DocState; readonly viewable: boolean }[];
  readonly state: DocState;
  /** Open follow-up request for this code, if any. */
  readonly requested: RequestedItemWire | null;
}
const STATE_RANK: readonly DocState[] = ["blocked", "rejected", "missing", "scanning", "to_review", "accepted"];
/**
 * Checklist by requirement code. The admin payload carries no requirement set, so this lists what was uploaded plus
 * what was asked for; "missing" means a requested or awaiting upload, never a guess about what is required.
 */
export function checklist(app: BrandApplicationWire): readonly ChecklistRow[] {
  const codes = new Set<string>([...app.documents.map((d) => d.requirement_code), ...app.requested_items.filter((r) => r.kind === "document").map((r) => r.code)]);
  return [...codes].sort().map((code) => {
    const docs = app.documents.filter((d) => d.requirement_code === code).map((doc) => ({ doc, state: documentState(doc), viewable: isViewable(doc) }));
    const requested = app.requested_items.find((r) => r.code === code && r.satisfied !== true) ?? null;
    const state: DocState = docs.length === 0 ? "missing"
      : (STATE_RANK.find((s) => docs.some((d) => d.state === s)) ?? "to_review");
    return { code, documents: docs, state, requested };
  });
}
/** Candidate items for the needs-info multi-select: unsatisfied or problem documents plus the generic clarification. */
export function needsInfoCandidates(app: BrandApplicationWire): readonly { readonly code: string; readonly kind: "document" | "domain_verification" | "clarification" }[] {
  const docs = checklist(app).filter((r) => r.state !== "accepted").map((r) => ({ code: r.code, kind: "document" as const }));
  const domain = app.website_domain !== undefined && app.domain_verification?.status !== "verified" ? [{ code: "domain_verification", kind: "domain_verification" as const }] : [];
  return [...docs, ...domain, { code: "clarification", kind: "clarification" as const }];
}

/* ------------------------------------------------------------------ document viewer */

export const DOC_URL_MAX_MS = 15 * 60_000;
/**
 * Remaining validity of a signed URL using the SERVER clock at receipt plus the monotonic time elapsed since
 * (never the device wall clock, which an operator can change).
 */
export function urlRemainingMs(p: { expiresAtMs: number; serverNowAtReceiptMs: number; elapsedSinceReceiptMs: number }): number {
  return Math.max(0, p.expiresAtMs - (p.serverNowAtReceiptMs + p.elapsedSinceReceiptMs));
}
export function mmss(ms: number): string {
  const s = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
/** True when the expiry is not plausible (already past, or beyond the contractual 15 minutes): refuse to render. */
export function urlLooksValid(p: { expiresAtMs: number; serverNowMs: number }): boolean {
  const left = p.expiresAtMs - p.serverNowMs;
  return left > 0 && left <= DOC_URL_MAX_MS + 30_000;
}
export const watermarkText = (reviewerId: string, applicationId: string, serverNowIso: string): string =>
  `${reviewerId.slice(0, 8)} · ${applicationId.slice(0, 8)} · ${serverNowIso.slice(0, 16).replace("T", " ")}Z`;
export type ViewerKind = "image" | "pdf";
export const viewerKind = (contentType: BrandDocumentWire["content_type"]): ViewerKind => (contentType === "application/pdf" ? "pdf" : "image");

/* ------------------------------------------------------------------ trademark, auto-check, conflict */

const LEGAL_SUFFIX = new Set(["ltd", "limited", "llc", "inc", "incorporated", "corp", "corporation", "co", "company", "gmbh", "sa", "sae", "plc", "ag", "bv", "srl", "spa", "the", "شركه", "ذ", "المحدوده", "ش", "م", "ذ"]);
export function normalizeName(s: string): string[] {
  return s
    .normalize("NFKD")
    .replace(/[ً-ٰٟ̀-ͯ]/g, "")
    .replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي")
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, " ")
    .split(" ")
    .filter((t) => t !== "" && !LEGAL_SUFFIX.has(t));
}
/** Indicative 0-100 token overlap (Jaccard). The register verdict from the API stays authoritative. */
export function nameMatchScore(a: string, b: string): number {
  const x = new Set(normalizeName(a));
  const y = new Set(normalizeName(b));
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter += 1;
  return Math.round((inter * 100) / (x.size + y.size - inter));
}
export interface TrademarkView {
  readonly id: string;
  readonly source: TrademarkEvidenceWire["source"];
  readonly found: boolean;
  readonly registerNumber: string | null;
  readonly ownerName: string | null;
  readonly status: string | null;
  readonly classes: readonly number[];
  readonly verdict: "yes" | "no" | "unknown";
  readonly score: number | null;
  readonly explanationKey: MessageKey;
  readonly retrievedAtMs: number;
}
export function trademarkView(e: TrademarkEvidenceWire, applicantNames: readonly string[]): TrademarkView {
  const verdict = e.owner_matches_applicant ?? "unknown";
  const score = e.found && e.owner_name !== undefined && applicantNames.length > 0 ? Math.max(...applicantNames.map((n) => nameMatchScore(e.owner_name ?? "", n))) : null;
  const explanationKey: MessageKey = !e.found ? "brand.tm.notFound"
    : verdict === "yes" ? "brand.tm.ownerYes"
      : verdict === "no" ? "brand.tm.ownerNo"
        : score !== null && score >= 60 ? "brand.tm.ownerUnknownClose" : "brand.tm.ownerUnknown";
  return {
    id: e.id, source: e.source, found: e.found, registerNumber: e.register_number ?? null, ownerName: e.owner_name ?? null,
    status: e.status ?? null, classes: e.classes ?? [], verdict, score, explanationKey, retrievedAtMs: Date.parse(e.retrieved_at),
  };
}
/** Newest first; one lookup per source is enough for the reviewer, the history keeps the rest. */
export function trademarkViews(app: AdminBrandApplicationWire): readonly TrademarkView[] {
  const names = [app.application.legal_name, app.application.brand_name].filter((n): n is string => n !== undefined && n !== "");
  return (app.trademark_evidence ?? []).map((e) => trademarkView(e, names)).sort((a, b) => b.retrievedAtMs - a.retrievedAtMs);
}

export type CheckTone = "ok" | "warn" | "bad" | "neutral";
export const checkTone = (r: AutoCheckWire["result"]): CheckTone => (r === "pass" ? "ok" : r === "warn" ? "warn" : r === "fail" || r === "error" ? "bad" : "neutral");
/** Worst result first so the reviewer sees problems at the top. */
export function sortedChecks(checks: readonly AutoCheckWire[]): readonly AutoCheckWire[] {
  const rank: Record<AutoCheckWire["result"], number> = { fail: 0, error: 1, warn: 2, skipped: 3, pass: 4 };
  return [...checks].sort((a, b) => rank[a.result] - rank[b.result] || a.code.localeCompare(b.code));
}

export interface ConflictRow {
  readonly field: MessageKey;
  readonly current: string;
  readonly other: string;
  readonly same: boolean;
}
export interface ConflictView {
  readonly otherId: string;
  readonly rows: readonly ConflictRow[];
  /** Fields that agree (same legal owner is plausible). */
  readonly agreeCount: number;
  readonly differCount: number;
  /** Earlier submission, which "keep_first" favours. */
  readonly currentIsFirst: boolean | null;
}
const val = (v: string | undefined | null): string => (v === undefined || v === null || v === "" ? "—" : v);
const norm = (s: string): string => normalizeName(s).join(" ");
export function conflictView(current: AdminBrandApplicationWire, other: AdminBrandApplicationWire): ConflictView {
  const a = current.application;
  const b = other.application;
  const tm = (x: AdminBrandApplicationWire): TrademarkEvidenceWire | undefined => x.trademark_evidence?.find((e) => e.found);
  const rows: [MessageKey, string, string][] = [
    ["brand.cmp.brand", val(a.brand_name), val(b.brand_name)],
    ["brand.cmp.legal", val(a.legal_name), val(b.legal_name)],
    ["brand.cmp.country", a.country, b.country],
    ["brand.cmp.kind", a.brand_kind, b.brand_kind],
    ["brand.cmp.domain", val(a.website_domain), val(b.website_domain)],
    ["brand.cmp.basis", val(a.ownership_basis), val(b.ownership_basis)],
    ["brand.cmp.tmOwner", val(tm(current)?.owner_name), val(tm(other)?.owner_name)],
    ["brand.cmp.tmNumber", val(tm(current)?.register_number), val(tm(other)?.register_number)],
    ["brand.cmp.status", a.status, b.status],
    ["brand.cmp.submitted", val(a.submitted_at), val(b.submitted_at)],
  ];
  const out = rows.map(([field, c, o]) => ({ field, current: c, other: o, same: c !== "—" && norm(c) === norm(o) && norm(c) !== "" }));
  const informative = out.filter((r) => r.field !== "brand.cmp.submitted" && r.field !== "brand.cmp.status");
  const ta = a.submitted_at === undefined || a.submitted_at === null ? NaN : Date.parse(a.submitted_at);
  const tb = b.submitted_at === undefined || b.submitted_at === null ? NaN : Date.parse(b.submitted_at);
  return {
    otherId: b.id,
    rows: out,
    agreeCount: informative.filter((r) => r.same).length,
    differCount: informative.filter((r) => !r.same).length,
    currentIsFirst: Number.isNaN(ta) || Number.isNaN(tb) ? null : ta <= tb,
  };
}

/* ------------------------------------------------------------------ keyboard shortcuts */

export type ShortcutId = "next" | "prev" | "open" | "claim" | "release" | "approve" | "reject" | "needs_info" | "mine" | "queue" | "help";
export const SHORTCUTS: readonly { readonly key: string; readonly id: ShortcutId; readonly scope: "queue" | "detail" | "both"; readonly labelKey: MessageKey }[] = [
  { key: "j", id: "next", scope: "queue", labelKey: "brand.sc.next" },
  { key: "k", id: "prev", scope: "queue", labelKey: "brand.sc.prev" },
  { key: "Enter", id: "open", scope: "queue", labelKey: "brand.sc.open" },
  { key: "c", id: "claim", scope: "detail", labelKey: "brand.sc.claim" },
  { key: "l", id: "release", scope: "detail", labelKey: "brand.sc.release" },
  { key: "a", id: "approve", scope: "detail", labelKey: "brand.sc.approve" },
  { key: "x", id: "reject", scope: "detail", labelKey: "brand.sc.reject" },
  { key: "i", id: "needs_info", scope: "detail", labelKey: "brand.sc.needsInfo" },
  { key: "g", id: "mine", scope: "both", labelKey: "brand.sc.mine" },
  { key: "q", id: "queue", scope: "both", labelKey: "brand.sc.queue" },
  { key: "?", id: "help", scope: "both", labelKey: "brand.sc.help" },
];
export interface KeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly targetTag: string;
  readonly targetEditable: boolean;
  readonly dialogOpen: boolean;
}
/** Single keys only; never while typing, with a modifier, or while a dialog is open (so a confirm cannot be hit by accident). */
export function resolveShortcut(e: KeyEvent, scope: "queue" | "detail"): ShortcutId | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.dialogOpen || e.targetEditable) return null;
  if (["INPUT", "TEXTAREA", "SELECT", "BUTTON", "A"].includes(e.targetTag.toUpperCase()) && e.key === "Enter") return null;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.targetTag.toUpperCase())) return null;
  const hit = SHORTCUTS.find((s) => s.key === e.key && (s.scope === "both" || s.scope === scope));
  return hit?.id ?? null;
}
/** Index movement for the queue list, clamped (no wrap: the end of a keyset page is a real boundary). */
export function moveSelection(index: number, count: number, dir: "next" | "prev"): number {
  if (count === 0) return -1;
  if (index < 0) return dir === "next" ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, index + (dir === "next" ? 1 : -1)));
}

/* ------------------------------------------------------------------ write outcome -> message */

const CONFLICT_CODE_KEYS: Readonly<Record<string, MessageKey>> = {
  reviewer_is_applicant: "brand.flash.reviewerIsApplicant",
  already_claimed: "brand.flash.alreadyClaimed",
};
/** Flash codes are `ok`, an ApiErrorKind, or `conflict.<problem code>` for the 409s the review flow defines. */
export function flashFor(code: string | undefined): { key: MessageKey; tone: "ok" | "error" } | null {
  if (code === undefined) return null;
  if (code === "ok") return { key: "flash.ok", tone: "ok" };
  if (code.startsWith("conflict.")) return { key: CONFLICT_CODE_KEYS[code.slice(9)] ?? "brand.flash.stale", tone: "error" };
  const map: Readonly<Record<string, MessageKey>> = {
    conflict: "brand.flash.stale", forbidden: "state.forbidden", not_found: "state.notFound", validation: "flash.validation",
    rate_limited: "state.rateLimited", unauthorized: "state.sessionExpired", unavailable: "state.unavailable", offline: "state.offline",
    server: "state.error", contract: "state.contract", not_configured: "state.notConfigured",
  };
  const key = map[code];
  return key === undefined ? null : { key, tone: "error" };
}
export function flashCode(error: { kind: string; code?: string }): string {
  return error.kind === "conflict" && error.code !== undefined && /^[a-z_]{1,40}$/.test(error.code) ? `conflict.${error.code}` : error.kind;
}

/* ------------------------------------------------------------------ generic facts */

/** Flat primitive entries of a loose server record (already masked server-side). Nested values are skipped, never stringified. */
export function primitiveEntries(rec: Readonly<Record<string, unknown>> | undefined): readonly (readonly [string, string])[] {
  if (rec === undefined) return [];
  return Object.entries(rec)
    .filter((e): e is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof e[1]) && String(e[1]) !== "")
    .map(([k, v]) => [k, String(v)] as const);
}
