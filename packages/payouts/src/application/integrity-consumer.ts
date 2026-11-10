import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import type { InboxOutcome } from "@outlet/outbox";
import { z } from "zod";
import { INTEGRITY_REQUESTED_EVENT } from "./integrity-job.js";
import type { IntegrityJob, IntegrityReport } from "./integrity-job.js";

export { INTEGRITY_REQUESTED_EVENT };
export const INTEGRITY_CONSUMER = "finance.integrity";

/**
 * `window` = "<scope>:YYYY-MM-DD" (market-local date of the tick); the date becomes the run's business date. `ledger_integrity_full` is the weekly full
 * pass (cursor reset to 0). `continuation` > 0 marks a self-emitted resume event of an unfinished run.
 */
export const IntegrityRequest = z.object({
  scope: z.enum(["ledger_integrity", "ledger_integrity_full"]),
  window: z.string().regex(/^ledger_integrity(_full)?:\d{4}-\d{2}-\d{2}$/).optional(),
  continuation: z.number().int().min(0).optional(),
}).loose();

export interface IntegrityEventIn {
  readonly id: string;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Inbox consumer of `ledger.integrity_requested` (nightly scheduler tick, weekly full tick, or a continuation), worker job `finance.reconcile`.
 * Chain verification runs first as pages in their own short transactions (each stores the cursor); then ONE transaction commits the inbox row together with
 * the stored result (or the continuation event): a failed final step leaves no inbox row, is redelivered and resumes from the stored cursor.
 * A malformed payload is parked (inbox row, no run). The result is idempotent per (market, business date), so a redelivery after a lost ack only replaces the run.
 */
export class IntegrityConsumer {
  constructor(private readonly client: RoleSqlClient<"outlet_worker">, private readonly marketId: string, private readonly job: IntegrityJob, private readonly now: () => Date = () => new Date()) {}

  async handle(event: IntegrityEventIn): Promise<InboxOutcome> {
    const req = event.type === INTEGRITY_REQUESTED_EVENT ? IntegrityRequest.safeParse(event.payload) : null;
    if (!req?.success) {
      return this.tx(async (tx) => (await this.claim(tx, event.id)) ? "processed" : "duplicate"); // parked: nothing to run
    }
    // A redelivered event must not redo (or, for a full pass, restart) the verification.
    const seen = await this.tx((tx) => tx.query("SELECT 1 FROM inbox_processed WHERE consumer = $1 AND message_id = $2", [INTEGRITY_CONSUMER, event.id]));
    if (seen.rows.length > 0) return "duplicate";
    const at = this.now();
    const date = req.data.window?.split(":")[1] ?? at.toISOString().slice(0, 10);
    const opts = { full: req.data.scope === "ledger_integrity_full", continuation: req.data.continuation ?? 0 };
    const progress = await this.job.advance(this.marketId, at, date, opts);
    return this.tx(async (tx) => {
      if (!(await this.claim(tx, event.id))) return "duplicate";
      await this.job.finalizeIn(tx, this.marketId, at, date, progress, opts);
      return "processed";
    });
  }

  private async claim(tx: Queryable, id: string): Promise<boolean> {
    const ins = await tx.query("INSERT INTO inbox_processed (consumer, message_id) VALUES ($1, $2) ON CONFLICT (consumer, message_id) DO NOTHING RETURNING message_id", [INTEGRITY_CONSUMER, id]);
    return ins.rows.length > 0;
  }

  private tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.client, { kind: "worker", marketId: this.marketId, job: "finance.reconcile" }, fn);
  }
}

export type { IntegrityReport };
