import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { createLogger } from "@outlet/logger";
import type { Logger } from "@outlet/logger";
import type { InboxOutcome } from "@outlet/outbox";
import { RollupService } from "./rollup.js";
import { ROLLUP_CONSUMER, ROLLUP_REQUESTED_EVENT, ROLLUP_WINDOW_MS, RollupRequest, STALE_WINDOWS, tickWindowStart } from "./schemas.js";

export interface RollupEventIn {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Inbox consumer of `reporting.rollup_requested` (a scheduler tick), worker job `reporting.rollup`. One transaction per market: the inbox row and
 * every upsert commit together, so a failed tick leaves no half-written day and is simply redelivered. A malformed payload is parked (inbox row + error
 * log) so it cannot loop. Scheduling: sales every 5 minutes (last 3 days), snapshots every 60 seconds, nightly 90 days (plan section 5).
 */
export class RollupConsumer {
  private readonly log: Logger;
  private readonly now: () => Date;
  constructor(private readonly client: RoleSqlClient<"outlet_worker">, private readonly marketId: string, private readonly service: RollupService, log?: Logger, now?: () => Date) {
    this.log = log ?? createLogger();
    this.now = now ?? (() => new Date());
  }

  async handle(event: RollupEventIn): Promise<InboxOutcome> {
    const seen = await this.tx((tx) => tx.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [ROLLUP_CONSUMER, event.id]));
    if (seen.rows.length > 0) return "duplicate";
    const req = event.type === ROLLUP_REQUESTED_EVENT ? RollupRequest.safeParse(event.payload) : null;
    return this.tx(async (tx) => {
      const ins = await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [ROLLUP_CONSUMER, event.id]);
      if (ins.rows.length === 0) return "duplicate";
      if (!req?.success) {
        this.log.error("reporting.rollup: event parked, not run", { event_id: event.id, type: event.type, reason: req === null ? "unknown_type" : "invalid_payload" });
        return "processed";
      }
      const { scope, days } = req.data;
      // A backlog (worker down, rollup kill switch released) must not replay every missed window: a snapshots / sales tick older than two of its
      // windows is consumed without work, because the newest tick recomputes the same state. Nightly has no window here and always runs.
      const start = tickWindowStart(req.data);
      if (start !== null && scope !== "nightly" && this.now().getTime() - start > STALE_WINDOWS * ROLLUP_WINDOW_MS[scope]) {
        this.log.info("reporting.rollup: stale tick skipped", { event_id: event.id, scope });
        return "processed";
      }
      if (scope === "snapshots") await this.service.snapshotsIn(tx, this.marketId);
      else await this.service.runRecentIn(tx, this.marketId, days ?? (scope === "nightly" ? 90 : 3));
      return "processed";
    });
  }

  private tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.client, { kind: "worker", marketId: this.marketId, job: "reporting.rollup" }, fn);
  }
}
