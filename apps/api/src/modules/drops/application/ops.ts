import type { Drop } from "../domain/bridge";
import type { Clock, DropOpsSource, DropStore, KeysetPosition } from "../domain/ports";
import { decodeCursor, encodeCursor, MAX_PAGE } from "./shared";

export const OPS_WINDOW_MS = 60_000;

export type AdmissionHealth = "healthy" | "degraded" | "unmeasured";

export interface DropOpsRow {
  readonly dropId: string;
  readonly storeId: string;
  readonly state: Drop["state"];
  readonly paused: boolean;
  readonly configuredAdmitPerSec: number;
  /** null = unmeasured (no counter source, or the queue backend is unreachable). */
  readonly queueDepth: number | null;
  readonly admittedLastMinute: number | null;
  /** Measured, not configured: admitted last minute / 60, one decimal as a string. */
  readonly admittedPerSec: string | null;
  /** Rejected / (admitted + rejected) in basis points; null when there were no decisions in the window. */
  readonly botBlockRateBps: number | null;
  readonly waitlistSize: number;
  readonly admissionHealth: AdmissionHealth;
}

export type OpsPage =
  | { readonly kind: "ok"; readonly items: readonly DropOpsRow[]; readonly nextCursor: string | null }
  | { readonly kind: "invalid_cursor" };

/**
 * Admission health, from stored counters only. Unmeasured when the queue depth could not be read.
 * Degraded when people are waiting on a live, unpaused drop but nobody was admitted in the window.
 */
export function admissionHealth(d: Drop, queueDepth: number | null, admitted: number | null): AdmissionHealth {
  if (queueDepth === null || admitted === null) return "unmeasured";
  const running = (d.state === "LIVE" || d.state === "EARLY_ACCESS") && !d.paused;
  return running && queueDepth > 0 && admitted === 0 ? "degraded" : "healthy";
}

export class AdminDropsOps {
  constructor(
    private readonly store: DropStore,
    private readonly source: DropOpsSource | null,
    private readonly clock: Clock,
  ) {}

  async execute(cursor: string | null, limit: number): Promise<OpsPage> {
    let after: KeysetPosition | null = null;
    if (cursor !== null) {
      after = decodeCursor(cursor);
      if (after === null) return { kind: "invalid_cursor" };
    }
    const size = Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE);
    const a = after;
    const all = [...(await this.store.active())]
      .sort((x, y) => x.startsAtMs - y.startsAtMs || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
      .filter((d) => a === null || d.startsAtMs > a.startsAtMs || (d.startsAtMs === a.startsAtMs && d.id > a.id));
    const slice = all.slice(0, size);
    const last = slice[slice.length - 1];
    const rows: DropOpsRow[] = [];
    for (const d of slice) rows.push(await this.row(d));
    return {
      kind: "ok",
      items: rows,
      nextCursor: all.length > size && last !== undefined ? encodeCursor({ startsAtMs: last.startsAtMs, id: last.id }) : null,
    };
  }

  private async row(d: Drop): Promise<DropOpsRow> {
    void this.clock;
    const waitlistSize = await this.store.waitlistSize(d.id);
    let queueDepth: number | null = null;
    let admitted: number | null = null;
    let bot: number | null = null;
    if (this.source !== null) {
      queueDepth = await this.source.queueDepth(d.id);
      const c = await this.source.windowCounts(d.id, OPS_WINDOW_MS);
      admitted = c.admitted;
      const decisions = c.admitted + c.rejected;
      bot = decisions === 0 ? null : Math.floor((c.rejected * 10_000) / decisions);
    }
    return {
      dropId: d.id,
      storeId: d.storeId,
      state: d.state,
      paused: d.paused,
      configuredAdmitPerSec: d.admitPerSec,
      queueDepth,
      admittedLastMinute: admitted,
      admittedPerSec: admitted === null ? null : (admitted / 60).toFixed(1),
      botBlockRateBps: bot,
      waitlistSize,
      admissionHealth: admissionHealth(d, queueDepth, admitted),
    };
  }
}
