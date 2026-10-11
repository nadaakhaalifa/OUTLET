import { storeCreditDrift, checkTrialBalance, type ProjectionRow, type StoredBalance } from "../ledger-posting/integrity";
import type { SubmissionState } from "../tax/submission";
import { severityOf } from "./aging";
import { conserves, matchLines, type MatchResult } from "./matcher";
import type { ParsedSettlement } from "./settlement-file";
import type { Finding, FindingKind, ReconLine, ReconSource } from "./types";

function finding(
  source: ReconSource,
  kind: FindingKind,
  ref: string,
  lineIds: readonly string[],
  delta: bigint,
  atMs: number,
  detail = "",
): Finding {
  const subject = lineIds.length > 0 ? [...lineIds].sort().join("|") : ref;
  return {
    source,
    kind,
    severity: severityOf(kind),
    ref,
    lineIds,
    delta,
    atMs,
    dedupeKey: `${source}:${kind}:${subject}`,
    detail,
  };
}

export const byDedupe = (a: Finding, b: Finding): number =>
  a.dedupeKey < b.dedupeKey ? -1 : a.dedupeKey > b.dedupeKey ? 1 : 0;

/** Turns a match result into findings. Matched pairs produce nothing. */
export function findingsFromMatch(source: ReconSource, r: MatchResult): Finding[] {
  const out: Finding[] = [];
  for (const m of r.mismatched) {
    out.push(finding(source, "amount_mismatch", m.key, [m.externalId, m.internalId], m.external - m.internal, m.atMs));
  }
  for (const l of r.unmatchedExternal) out.push(finding(source, "unmatched_external", l.key, [l.id], l.amount, l.atMs));
  for (const l of r.unmatchedInternal) out.push(finding(source, "unmatched_internal", l.key, [l.id], -l.amount, l.atMs));
  for (const l of r.duplicateExternal) out.push(finding(source, "duplicate_external", l.key, [l.id], l.amount, l.atMs));
  for (const l of r.duplicateInternal) out.push(finding(source, "duplicate_internal", l.key, [l.id], -l.amount, l.atMs));
  return out.sort(byDedupe);
}

export interface PostedSettlement {
  readonly gross: bigint;
  readonly fee: bigint;
}

export type SettlementFileSource = "psp_settlement" | "cod_remittance" | "bnpl_settlement";

/** External lines of a parsed file in matcher terms: gross signed, keyed by provider reference. */
export function fileLines(file: ParsedSettlement): ReconLine[] {
  return file.lines.map((l) => ({
    id: `${file.settlementId}#${l.lineNo}`,
    key: l.providerRef,
    amount: l.gross,
    atMs: l.occurredAtMs,
  }));
}

/**
 * One settlement file against the clearing account movements for its party and window, plus the
 * posted settlement entry (gross and fee) when there is one. `posted: null` means the settlement
 * has not been posted to the ledger yet.
 */
export function reconcileSettlementFile(input: {
  readonly source: SettlementFileSource;
  readonly file: ParsedSettlement;
  readonly internal: readonly ReconLine[];
  readonly posted: PostedSettlement | null;
}): { readonly findings: readonly Finding[]; readonly match: MatchResult } {
  const match = matchLines(fileLines(input.file), input.internal);
  const findings = findingsFromMatch(input.source, match);
  const at = input.file.lines.reduce((m, l) => Math.min(m, l.occurredAtMs), Number.MAX_SAFE_INTEGER);
  const fileId = input.file.settlementId;
  if (input.posted === null) {
    findings.push(finding(input.source, "settlement_not_posted", fileId, [], input.file.totals.net, at));
  } else if (input.posted.gross !== input.file.totals.gross || input.posted.fee !== input.file.totals.fee) {
    const postedNet = input.posted.gross - input.posted.fee;
    findings.push(
      finding(input.source, "settlement_posting_mismatch", fileId, [], input.file.totals.net - postedNet, at,
        `gross_delta=${input.file.totals.gross - input.posted.gross};fee_delta=${input.file.totals.fee - input.posted.fee}`),
    );
  }
  return { findings: findings.sort(byDedupe), match };
}

/**
 * ADV-W4-4, conservation ACROSS files. One internal clearing line can settle once, so the same
 * (provider reference, line kind, signed gross) must not be reported by two settlement files of
 * the same provider. The matcher is per file and would happily match both copies to the same
 * internal line. The first file (lowest settlement id) keeps the line; every later copy is a
 * `duplicate_external` finding. A refund of ref-1 (negative) is a different line kind and amount,
 * so a legitimate reversal never trips this.
 */
export function reconcileAcrossFiles(
  source: SettlementFileSource,
  files: readonly ParsedSettlement[],
): Finding[] {
  const out: Finding[] = [];
  const byProvider = new Map<string, ParsedSettlement[]>();
  for (const f of files) byProvider.set(f.provider, [...(byProvider.get(f.provider) ?? []), f]);
  for (const group of byProvider.values()) {
    const ordered = [...group].sort((a, b) => (a.settlementId < b.settlementId ? -1 : a.settlementId > b.settlementId ? 1 : 0));
    const owner = new Map<string, string>();
    for (const f of ordered) {
      for (const l of f.lines) {
        const k = `${l.providerRef}|${l.kind}|${l.gross.toString()}`;
        const first = owner.get(k);
        if (first === undefined) {
          owner.set(k, f.settlementId);
        } else if (first !== f.settlementId) {
          out.push(
            finding(source, "duplicate_external", l.providerRef, [`${f.settlementId}#${l.lineNo}`], l.gross, l.occurredAtMs,
              `first_seen_in=${first}`),
          );
        }
      }
    }
  }
  return out.sort(byDedupe);
}

export function rejectedFileFinding(source: SettlementFileSource, fileId: string, codes: readonly string[], atMs: number): Finding {
  return finding(source, "file_rejected", fileId, [], 0n, atMs, [...new Set(codes)].sort().join(","));
}

export interface EtaInternal {
  readonly internalId: string;
  readonly state: SubmissionState;
  readonly gross: bigint;
  readonly lastSubmittedAtMs: number | null;
  readonly createdAtMs: number;
}
export interface EtaReported {
  readonly internalId: string;
  readonly status: "ACCEPTED" | "REJECTED" | "PENDING";
}

export const ETA_STALE_AFTER_MS = 6 * 3_600_000;

/** ETA submitted versus accepted: the authority's view against ours, per internal document id. */
export function reconcileEta(input: {
  readonly internal: readonly EtaInternal[];
  readonly reported: readonly EtaReported[];
  readonly nowMs: number;
}): Finding[] {
  const out: Finding[] = [];
  const theirs = new Map(input.reported.map((r) => [r.internalId, r.status] as const));
  const ours = new Set<string>();
  for (const d of input.internal) {
    ours.add(d.internalId);
    const t = theirs.get(d.internalId);
    const at = d.lastSubmittedAtMs ?? d.createdAtMs;
    const id = d.internalId;
    if (d.state === "REJECTED" || d.state === "DEAD_LETTER") {
      out.push(finding("eta_submission", "eta_rejected", id, [id], d.gross, at, d.state));
      continue;
    }
    if (d.state === "QUEUED" || d.state === "RETRY") continue;
    if (t === undefined) {
      out.push(finding("eta_submission", "eta_missing_at_authority", id, [id], d.gross, at, d.state));
    } else if (
      (d.state === "ACCEPTED" && t !== "ACCEPTED") ||
      (d.state === "SUBMITTED" && t === "REJECTED") ||
      (d.state === "SUBMITTED" && t === "ACCEPTED")
    ) {
      out.push(finding("eta_submission", "eta_status_mismatch", id, [id], d.gross, at, `ours=${d.state};theirs=${t}`));
    } else if (d.state === "SUBMITTED" && input.nowMs - at > ETA_STALE_AFTER_MS) {
      out.push(finding("eta_submission", "eta_stale_submitted", id, [id], d.gross, at));
    }
  }
  for (const r of input.reported) {
    if (!ours.has(r.internalId)) {
      out.push(finding("eta_submission", "eta_unknown_at_authority", r.internalId, [r.internalId], 0n, input.nowMs));
    }
  }
  return out.sort(byDedupe);
}

export function reconcileStoreCredit(input: {
  readonly projection: readonly ProjectionRow[];
  readonly balances: readonly StoredBalance[];
  readonly nowMs: number;
}): Finding[] {
  const { drift, negative } = storeCreditDrift(input.projection, input.balances);
  const out: Finding[] = [];
  for (const d of drift) {
    out.push(finding("store_credit", "store_credit_drift", `${d.userId}:${d.sub}`, [], d.difference, input.nowMs));
  }
  for (const n of negative) {
    out.push(finding("store_credit", "store_credit_negative", `${n.userId}:${n.sub}`, [], n.fromPostings, input.nowMs));
  }
  return out.sort(byDedupe);
}

export function reconcileTrialBalance(totals: ReadonlyMap<string, bigint>, nowMs: number): Finding[] {
  return checkTrialBalance(totals).offenders.map((o) =>
    finding("trial_balance", "trial_balance", o.currency, [], o.total, nowMs),
  );
}

export function suiteFailedFinding(suite: string, nowMs: number): Finding {
  return {
    source: "run",
    kind: "suite_failed",
    severity: severityOf("suite_failed"),
    ref: suite,
    lineIds: [],
    delta: 0n,
    atMs: nowMs,
    dedupeKey: `suite:suite_failed:${suite}`,
    detail: suite,
  };
}

export { conserves };
