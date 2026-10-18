import { requiredDocumentGroups, type BrandRequirements } from "./requirements";
import {
  APPEAL_WINDOW_DAYS,
  DAY_MS,
  DECISION_SLA_BUSINESS_DAYS,
  EDITABLE_STATUSES,
  MIN_SIGNATORY_AGE,
  REAPPLY_COOLDOWN_DAYS,
  type ApplicationAction,
  type ApplicationStatus,
  type RequestedItemKind,
  type ReviewStatus,
  type ScanStatus,
  type UploadStatus,
} from "./types";
import { isSignatoryAdult, parseEgyptianNationalId, validateFieldValue, type FieldError } from "./validators";

export interface DocumentFacts {
  readonly requirementCode: string;
  readonly uploadStatus: UploadStatus;
  readonly scanStatus: ScanStatus;
  readonly reviewStatus: ReviewStatus;
}

export interface CompletenessFacts {
  readonly country: string;
  /** Flat map keyed by requirement field code. */
  readonly fields: Readonly<Record<string, string | undefined>>;
  readonly documents: readonly DocumentFacts[];
  readonly domainVerified: boolean;
  readonly acknowledgementsAccepted: boolean;
  readonly nowMs: number;
}

export type MissingKind = "field" | "invalid_field" | "document" | "document_pending_scan" | "domain_verification" | "acknowledgement" | "signatory_age";
export interface MissingItem {
  readonly code: string;
  readonly kind: MissingKind;
  readonly reason?: FieldError;
}

const usable = (doc: DocumentFacts): boolean =>
  doc.uploadStatus === "uploaded" && doc.scanStatus === "clean" && doc.reviewStatus !== "rejected" && doc.reviewStatus !== "unreadable";

/** Pure completeness check over the requirements-as-data. Order of `missing` is stable (fields, documents, extras). */
export function evaluateCompleteness(req: BrandRequirements, facts: CompletenessFacts): { complete: boolean; missing: readonly MissingItem[] } {
  const missing: MissingItem[] = [];
  for (const field of req.fields) {
    const v = facts.fields[field.code];
    if (v === undefined || v.trim() === "") {
      if (field.required) missing.push({ code: field.code, kind: "field" });
      continue;
    }
    const err = validateFieldValue(field.format, v, facts.country);
    if (err !== null) missing.push({ code: field.code, kind: "invalid_field", reason: err });
  }
  // Signatory age (21+): from the national id when Egyptian, else the stated date of birth.
  const dob = facts.fields["signatory_dob"];
  const nid = facts.fields["signatory_national_id"];
  const idDob = facts.country === "EG" && nid !== undefined ? parseEgyptianNationalId(nid)?.dob : undefined;
  const effectiveDob = idDob ?? dob;
  if (effectiveDob !== undefined && !isSignatoryAdult(effectiveDob, facts.nowMs)) {
    missing.push({ code: "signatory_dob", kind: "signatory_age" });
  }
  if (idDob !== undefined && dob !== undefined && idDob !== dob) {
    missing.push({ code: "signatory_dob", kind: "invalid_field", reason: "invalid_date" });
  }
  for (const group of requiredDocumentGroups(req)) {
    const docs = facts.documents.filter((x) => group.includes(x.requirementCode));
    if (docs.some(usable)) continue;
    const pending = docs.some((x) => x.uploadStatus === "uploaded" && x.scanStatus === "pending");
    missing.push({ code: group.join("|"), kind: pending ? "document_pending_scan" : "document" });
  }
  const hasWebsite = (facts.fields["website_domain"] ?? "").trim() !== "";
  const domainRequired = req.website_verification === "required" || (req.website_verification === "required_if_website" && hasWebsite);
  if (domainRequired && !facts.domainVerified) missing.push({ code: "website_domain", kind: "domain_verification" });
  if (!facts.acknowledgementsAccepted) missing.push({ code: "acknowledgements", kind: "acknowledgement" });
  return { complete: missing.length === 0, missing };
}

export interface RequestedItemState {
  readonly code: string;
  readonly kind: RequestedItemKind;
  readonly satisfied: boolean;
}

export interface SatisfactionEvidence {
  /** Document requirement codes with a usable upload created after the request. */
  readonly newDocumentCodes: ReadonlySet<string>;
  /** Field codes changed after the request. */
  readonly changedFieldCodes: ReadonlySet<string>;
  readonly domainVerified: boolean;
  /** Clarification codes the applicant confirmed on resubmit. */
  readonly clarifiedCodes: ReadonlySet<string>;
}

export function resolveRequestedItems<T extends RequestedItemState>(items: readonly T[], ev: SatisfactionEvidence): T[] {
  return items.map((it) => {
    if (it.satisfied) return it;
    const ok =
      it.kind === "document"
        ? ev.newDocumentCodes.has(it.code)
        : it.kind === "field"
          ? ev.changedFieldCodes.has(it.code)
          : it.kind === "domain_verification"
            ? ev.domainVerified
            : ev.clarifiedCodes.has(it.code);
    return ok ? { ...it, satisfied: true } : it;
  });
}

export const allRequestedSatisfied = (items: readonly RequestedItemState[]): boolean => items.every((i) => i.satisfied);

export const reapplyAfterMs = (rejectedAtMs: number): number => rejectedAtMs + REAPPLY_COOLDOWN_DAYS * DAY_MS;
export const reapplyAllowed = (rejectedAtMs: number, nowMs: number): boolean => nowMs >= reapplyAfterMs(rejectedAtMs);
export const appealDeadlineMs = (rejectedAtMs: number): number => rejectedAtMs + APPEAL_WINDOW_DAYS * DAY_MS;
export const appealOpen = (status: ApplicationStatus, rejectedAtMs: number | null, appealUsed: boolean, nowMs: number): boolean =>
  status === "REJECTED" && !appealUsed && rejectedAtMs !== null && nowMs <= appealDeadlineMs(rejectedAtMs);

const cairoWeekday = (ms: number): number => {
  const w = new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", weekday: "short" }).format(new Date(ms));
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(w);
};
/** Egypt weekend is Friday and Saturday (VERIFY: public holidays are not modelled). */
export function addBusinessDays(startMs: number, days: number): number {
  let ms = startMs;
  let left = days;
  while (left > 0) {
    ms += DAY_MS;
    const w = cairoWeekday(ms);
    if (w !== 5 && w !== 6) left -= 1;
  }
  return ms;
}
export const decisionDueMs = (submittedAtMs: number): number => addBusinessDays(submittedAtMs, DECISION_SLA_BUSINESS_DAYS);

export function allowedActions(
  status: ApplicationStatus,
  o: { appealOpen: boolean; domainVerificationNeeded: boolean },
): readonly ApplicationAction[] {
  const out: ApplicationAction[] = [];
  if (EDITABLE_STATUSES.includes(status)) out.push("edit", "upload_document");
  if (status === "DRAFT") out.push("submit");
  if (status === "NEEDS_INFO") out.push("resubmit");
  if (["DRAFT", "SUBMITTED", "AUTO_CHECKS", "IN_REVIEW", "NEEDS_INFO"].includes(status)) out.push("withdraw");
  if (o.appealOpen) out.push("appeal");
  if (o.domainVerificationNeeded && (status === "DRAFT" || status === "NEEDS_INFO")) out.push("verify_domain");
  return out;
}

export { MIN_SIGNATORY_AGE };
