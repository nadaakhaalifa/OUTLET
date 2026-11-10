import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import type { InboxOutcome } from "@outlet/outbox";
import { z } from "zod";
import { IntegrityJob } from "./integrity-job.js";
import type { IntegrityReport } from "./integrity-job.js";

export const INTEGRITY_REQUESTED_EVENT = "ledger.integrity_requested";
export const INTEGRITY_CONSUMER = "finance.integrity";

/** `window` = "ledger_integrity:YYYY-MM-DD" (market-local date of the tick); the date becomes the run's business date. */
export const IntegrityRequest = z.object({ scope: z.literal("ledger_integrity"), window: z.string().regex(/^ledger_integrity:\d{4}-\d{2}-\d{2}$/).optional() }).loose();

export interface IntegrityEventIn {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Inbox consumer of `ledger.integrity_requested` (nightly scheduler tick), worker job `finance.reconcile` (the job that already owns the ledger reads and the
 * reconciliation tables, so no new policy). The inbox row and the stored run commit in ONE transaction: a failed scan leaves no inbox row and is redelivered.
 * A malformed payload is parked (inbox row, no run). The scan is idempotent per (market, business date), so a redelivery after a lost ack only replaces the run.
 */
export class IntegrityConsumer {
  constructor(private readonly client: RoleSqlClient<"outlet_worker">, private readonly marketId: string, private readonly job: IntegrityJob, private readonly now: () => Date = () => new Date()) {}

  async handle(event: IntegrityEventIn): Promise<InboxOutcome> {
    const req = event.type === INTEGRITY_REQUESTED_EVENT ? IntegrityRequest.safeParse(event.payload) : null;
    return this.tx(async (tx) => {
      const ins = await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [INTEGRITY_CONSUMER, event.id]);
      if (ins.rows.length === 0) return "duplicate";
      if (!req?.success) return "processed"; // parked: nothing to run
      const date = req.data.window?.slice("ledger_integrity:".length);
      await this.job.runIn(tx, this.marketId, this.now(), date);
      return "processed";
    });
  }

  private tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.client, { kind: "worker", marketId: this.marketId, job: "finance.reconcile" }, fn);
  }
}

export type { IntegrityReport };
