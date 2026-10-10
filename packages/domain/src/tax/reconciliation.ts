import { InvalidTaxInputError } from "./errors";
import type { SubmissionState } from "./submission";

export interface ReconSubmission {
  readonly internalId: string;
  readonly state: SubmissionState;
  readonly gross: bigint;
  readonly etaUuid: string | null;
  readonly signedDocumentRef: string | null;
  readonly lastSubmittedAtMs: number | null;
}

export type EtaReportedStatus = "ACCEPTED" | "REJECTED" | "PENDING";

export interface EtaReportedItem {
  readonly internalId: string;
  readonly status: EtaReportedStatus;
}

export type DiscrepancyKind =
  | "rejected"
  | "dead_letter"
  | "stale_submitted"
  | "accepted_without_signed_document"
  | "accepted_without_eta_uuid"
  | "missing_at_eta"
  | "unknown_at_eta"
  | "status_mismatch";

export interface Discrepancy {
  readonly internalId: string;
  readonly kind: DiscrepancyKind;
}

export interface ReconciliationReport {
  readonly date: string;
  readonly documents: number;
  readonly counts: Readonly<Record<SubmissionState, number>>;
  readonly grossByState: Readonly<Record<SubmissionState, bigint>>;
  /** Documents that reached ETA (everything except QUEUED). */
  readonly submitted: number;
  readonly accepted: number;
  readonly rejected: number;
  /** accepted / (accepted + rejected) in basis points, null when nothing was decided. */
  readonly acceptanceRateBps: number | null;
  readonly discrepancies: readonly Discrepancy[];
  readonly reconciled: boolean;
}

export const STALE_SUBMITTED_AFTER_MS = 6 * 3_600_000;

const ZERO_COUNTS = (): Record<SubmissionState, number> => ({ QUEUED: 0, SUBMITTED: 0, ACCEPTED: 0, REJECTED: 0, RETRY: 0, DEAD_LETTER: 0 });
const ZERO_GROSS = (): Record<SubmissionState, bigint> => ({ QUEUED: 0n, SUBMITTED: 0n, ACCEPTED: 0n, REJECTED: 0n, RETRY: 0n, DEAD_LETTER: 0n });

/**
 * Pure daily report: submitted vs accepted vs rejected, plus every discrepancy that needs a human
 * (spec B4 "daily reconciliation report"). `etaReport` is ETA's own list for the day (null when
 * ETA could not be queried, in which case only internal checks run). Discrepancies are sorted.
 */
export function reconcileDay(input: {
  readonly date: string;
  readonly submissions: readonly ReconSubmission[];
  readonly etaReport: readonly EtaReportedItem[] | null;
  readonly nowMs: number;
  readonly staleAfterMs?: number;
}): ReconciliationReport {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new InvalidTaxInputError("date must be YYYY-MM-DD");
  const stale = input.staleAfterMs ?? STALE_SUBMITTED_AFTER_MS;
  const counts = ZERO_COUNTS();
  const grossByState = ZERO_GROSS();
  const found: Discrepancy[] = [];
  const eta = new Map<string, EtaReportedStatus>();
  if (input.etaReport !== null) for (const r of input.etaReport) eta.set(r.internalId, r.status);
  const ours = new Set<string>();

  for (const s of input.submissions) {
    ours.add(s.internalId);
    counts[s.state] += 1;
    grossByState[s.state] += s.gross;
    const add = (kind: DiscrepancyKind): void => void found.push({ internalId: s.internalId, kind });
    if (s.state === "REJECTED") add("rejected");
    if (s.state === "DEAD_LETTER") add("dead_letter");
    if (s.state === "SUBMITTED" && s.lastSubmittedAtMs !== null && input.nowMs - s.lastSubmittedAtMs > stale) add("stale_submitted");
    if (s.state === "ACCEPTED") {
      if (s.signedDocumentRef === null) add("accepted_without_signed_document");
      if (s.etaUuid === null) add("accepted_without_eta_uuid");
    }
    if (input.etaReport !== null && s.state !== "QUEUED" && s.state !== "RETRY" && s.state !== "DEAD_LETTER") {
      const theirs = eta.get(s.internalId);
      if (theirs === undefined) add("missing_at_eta");
      else if ((s.state === "ACCEPTED" && theirs !== "ACCEPTED") || (s.state === "REJECTED" && theirs !== "REJECTED")) add("status_mismatch");
      else if (s.state === "SUBMITTED" && theirs !== "PENDING") add("status_mismatch");
    }
  }
  if (input.etaReport !== null) {
    for (const r of input.etaReport) if (!ours.has(r.internalId)) found.push({ internalId: r.internalId, kind: "unknown_at_eta" });
  }
  found.sort((a, b) => (a.internalId === b.internalId ? a.kind.localeCompare(b.kind) : a.internalId < b.internalId ? -1 : 1));
  const decided = counts.ACCEPTED + counts.REJECTED;
  return {
    date: input.date,
    documents: input.submissions.length,
    counts,
    grossByState,
    submitted: input.submissions.length - counts.QUEUED,
    accepted: counts.ACCEPTED,
    rejected: counts.REJECTED,
    acceptanceRateBps: decided === 0 ? null : Math.floor((counts.ACCEPTED * 10_000) / decided),
    discrepancies: found,
    reconciled: found.length === 0 && counts.SUBMITTED === 0 && counts.QUEUED === 0 && counts.RETRY === 0,
  };
}

const cairoDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });

export function cairoDateOf(ms: number): string {
  return cairoDateFmt.format(new Date(ms));
}

/** [start, end) in epoch ms of a Cairo calendar day. Egypt is UTC+2, or UTC+3 under DST. */
export function cairoDayWindow(date: string): { readonly startMs: number; readonly endMs: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) throw new InvalidTaxInputError("date must be YYYY-MM-DD");
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const startOf = (utc: number): number => {
    for (const hours of [2, 3]) {
      const s = utc - hours * 3_600_000;
      if (cairoDateOf(s) === cairoDateOf(utc + 12 * 3_600_000) && cairoDateOf(s - 1) !== cairoDateOf(s)) return s;
    }
    throw new InvalidTaxInputError("could not resolve the Cairo day window");
  };
  const startMs = startOf(utcMidnight);
  const endMs = startOf(utcMidnight + 86_400_000);
  if (cairoDateOf(startMs) !== date) throw new InvalidTaxInputError("invalid calendar date");
  return { startMs, endMs };
}
