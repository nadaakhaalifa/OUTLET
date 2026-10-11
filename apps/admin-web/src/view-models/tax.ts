import type { TaxDocumentWire, TaxReconciliationWire } from "../api/schemas";
import { parseMinor } from "../lib/format";

export type SubmissionState = TaxDocumentWire["submission"]["state"];
const STATE_ORDER: readonly SubmissionState[] = ["DEAD_LETTER", "REJECTED", "RETRY", "QUEUED", "SUBMITTED", "ACCEPTED"];

export interface SubmissionRow {
  readonly id: string;
  readonly kind: TaxDocumentWire["kind"];
  readonly sourceRef: string;
  readonly state: SubmissionState;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly rejectionReasons: readonly string[];
  readonly grossMinor: bigint | null;
  readonly vatMinor: bigint | null;
  readonly etaUuid: string | null;
  /** Only dead-lettered submissions can be requeued (API returns 409 otherwise). */
  readonly canRequeue: boolean;
  readonly needsAttention: boolean;
}

export function submissionRow(d: TaxDocumentWire): SubmissionRow {
  const s = d.submission;
  return {
    id: d.id,
    kind: d.kind,
    sourceRef: d.source_ref,
    state: s.state,
    attempts: s.attempts,
    maxAttempts: s.max_attempts,
    lastError: s.last_error,
    rejectionReasons: s.rejection_reasons,
    grossMinor: parseMinor(d.totals.gross.amount),
    vatMinor: parseMinor(d.totals.vat.amount),
    etaUuid: s.eta_uuid,
    canRequeue: s.state === "DEAD_LETTER",
    needsAttention: s.state === "DEAD_LETTER" || s.state === "REJECTED",
  };
}

export interface SubmissionBoard {
  readonly rows: readonly SubmissionRow[];
  readonly counts: Readonly<Record<SubmissionState, number>>;
  readonly deadLetters: readonly SubmissionRow[];
}

export function submissionBoard(items: readonly TaxDocumentWire[]): SubmissionBoard {
  const rows = items
    .map(submissionRow)
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.id.localeCompare(b.id));
  const counts: Record<SubmissionState, number> = { DEAD_LETTER: 0, REJECTED: 0, RETRY: 0, QUEUED: 0, SUBMITTED: 0, ACCEPTED: 0 };
  for (const r of rows) counts[r.state] += 1;
  return { rows, counts, deadLetters: rows.filter((r) => r.canRequeue) };
}

export interface ReconciliationView {
  readonly date: string;
  readonly documents: number;
  readonly submitted: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly acceptanceBps: number | null;
  readonly discrepancyCount: number;
  readonly discrepancies: readonly { readonly internalId: string; readonly kind: string }[];
  /** True only when the server says so AND there are no discrepancies. Never inferred from an empty day. */
  readonly clean: boolean;
  readonly empty: boolean;
}

export function reconciliationView(r: TaxReconciliationWire): ReconciliationView {
  return {
    date: r.date,
    documents: r.documents,
    submitted: r.submitted,
    accepted: r.accepted,
    rejected: r.rejected,
    acceptanceBps: r.acceptance_rate_bps,
    discrepancyCount: r.discrepancies.length,
    discrepancies: r.discrepancies.map((d) => ({ internalId: d.internal_id, kind: d.kind })),
    clean: r.reconciled && r.discrepancies.length === 0,
    empty: r.documents === 0,
  };
}

/** Civil date (Africa/Cairo) of the day before `nowMs`, as YYYY-MM-DD: the daily reconciliation default. */
export function previousCairoDate(nowMs: number): string {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" });
  const today = fmt.format(new Date(nowMs));
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  return fmt.format(new Date(Date.UTC(y, m - 1, d - 1, 12)));
}
