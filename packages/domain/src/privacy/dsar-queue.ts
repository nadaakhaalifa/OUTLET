import { isDeletionActive, type DeletionRequest } from "./deletion-request";
import { isExportOverdue, isExportTerminal, type ExportRequest } from "./export-request";

/**
 * DSAR queue read model for the `dpo` role (spec B1: Privacy dashboard covers the DSAR queue).
 * Pure: takes requests and an injected clock.
 */
export const DSAR_SLA_DAYS = 30; // VERIFY BEFORE LAUNCH: statutory deadline (spec B1).
const DAY_MS = 86_400_000;
const DAY_WINDOW_MS = DAY_MS;

export type PrivacyRequest = ExportRequest | DeletionRequest;
export type DsarKind = PrivacyRequest["kind"];

export interface DsarQueueItem {
  readonly id: string;
  readonly kind: DsarKind;
  readonly userId: string;
  readonly status: string;
  readonly requestedAtMs: number;
  /** SLA due date (30 days default) for both kinds. */
  readonly dueAtMs: number;
  readonly msRemaining: number;
  readonly overdue: boolean;
  /** Exports only: the 72 h readiness target and whether it was missed. */
  readonly readyTargetAtMs: number | null;
  readonly readyTargetMissed: boolean;
  /** Deletions only: when cooling ends. */
  readonly coolingEndsAtMs: number | null;
  readonly blockerKinds: readonly string[];
}

export interface DsarQueueFilter {
  readonly kind?: DsarKind;
  readonly overdueOnly?: boolean;
  readonly includeClosed?: boolean;
}

export interface DsarQueueSummary {
  readonly open: number;
  readonly overdue: number;
  readonly dueWithin24h: number;
  readonly byKind: Readonly<Record<DsarKind, number>>;
}

export interface DsarQueue {
  readonly items: readonly DsarQueueItem[];
  readonly summary: DsarQueueSummary;
}

export function isPrivacyRequestOpen(r: PrivacyRequest): boolean {
  return r.kind === "export" ? !isExportTerminal(r) : isDeletionActive(r);
}

function toItem(r: PrivacyRequest, nowMs: number): DsarQueueItem {
  const dueAtMs = r.requestedAtMs + DSAR_SLA_DAYS * DAY_MS;
  const open = isPrivacyRequestOpen(r);
  const readyTargetMissed = r.kind === "export" && isExportOverdue(r, nowMs);
  return {
    id: r.id,
    kind: r.kind,
    userId: r.userId,
    status: r.status,
    requestedAtMs: r.requestedAtMs,
    dueAtMs,
    msRemaining: dueAtMs - nowMs,
    overdue: open && (nowMs > dueAtMs || readyTargetMissed),
    readyTargetAtMs: r.kind === "export" ? r.readyTargetAtMs : null,
    readyTargetMissed,
    coolingEndsAtMs: r.kind === "delete" ? r.coolingEndsAtMs : null,
    blockerKinds: r.kind === "delete" ? r.blockers.map((b) => b.kind) : [],
  };
}

export function buildDsarQueue(
  requests: readonly PrivacyRequest[],
  nowMs: number,
  filter: DsarQueueFilter = {},
): DsarQueue {
  const all = requests.map((r) => ({ r, item: toItem(r, nowMs), open: isPrivacyRequestOpen(r) }));
  const considered = all.filter((x) => (filter.includeClosed === true ? true : x.open));
  const items = considered
    .map((x) => x.item)
    .filter((i) => (filter.kind === undefined ? true : i.kind === filter.kind))
    .filter((i) => (filter.overdueOnly === true ? i.overdue : true))
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.dueAtMs !== b.dueAtMs) return a.dueAtMs - b.dueAtMs;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  const openItems = all.filter((x) => x.open).map((x) => x.item);
  const byKind: Record<DsarKind, number> = { export: 0, delete: 0 };
  for (const i of openItems) byKind[i.kind] += 1;
  return {
    items,
    summary: {
      open: openItems.length,
      overdue: openItems.filter((i) => i.overdue).length,
      dueWithin24h: openItems.filter((i) => !i.overdue && i.dueAtMs - nowMs <= DAY_WINDOW_MS).length,
      byKind,
    },
  };
}
