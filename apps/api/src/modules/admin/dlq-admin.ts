import { contextClient, withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { DlqReplay } from "@outlet/outbox";
import type { DiscardReasonCode, DlqResult } from "@outlet/outbox";
import type { Principal } from "@outlet/policy";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import { Problems } from "../../platform/problem.js";
import type { DlqActionResult, DlqPage } from "./dto-dlq.js";
import type { AuditAppendPort } from "./ports.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DlqAdminPort {
  list(p: Principal, q: { readonly limit: number; readonly cursor?: string | undefined }): Promise<DlqPage>;
  /** Event type per open DLQ id of the market (ids not in the DLQ are absent): decides whether a discard needs a second approver. */
  types(p: Principal, ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** Intent audit `dlq.replay_requested` BEFORE the effect, then the effect, then `dlq.replayed` (counts and ids only) when something changed. Idempotent: an id not in the DLQ is `not_in_dlq`; one dead-lettered over 45 days ago is `expired` (discard only). */
  replay(p: Principal, ids: readonly string[]): Promise<DlqActionResult>;
  /** Intent audit `dlq.discard_requested` BEFORE the effect, then the effect only (runs as the outbox.relay worker job, other role than the audit write): the caller records it with `record`, in the approval's claim transaction when there is one. */
  discard(p: Principal, ids: readonly string[], reason: DiscardReasonCode): Promise<DlqActionResult>;
  /** Audit entry `dlq.discarded` for an applied discard; `tx` joins the caller's transaction (an approval claim), otherwise its own outlet_app transaction. */
  record(p: Principal, r: DlqActionResult, extra: { readonly reasonCode: DiscardReasonCode; readonly approvalRequestId?: string }, tx?: Queryable): Promise<void>;
}

const APPLIED = (o: DlqResult["outcome"]): boolean => o === "replayed" || o === "discarded";
const result = (rs: readonly DlqResult[]): DlqActionResult => ({ results: rs.map((r) => ({ id: r.id, outcome: r.outcome })), changed: rs.filter((r) => APPLIED(r.outcome)).length });

/**
 * Staff side of the relay DLQ. The mutation runs as the `outbox.relay` worker job (the only job whose policies reach outbox_events and dlq_messages, migration 0007)
 * on the market's own pin, through `@outlet/outbox` DlqReplay (no SECURITY DEFINER function, no new grant). The worker and the audit chain are different roles, so one
 * transaction cannot hold both: an INTENT entry (`dlq.*_requested`, ids and reason only) is committed through the outlet_app chain BEFORE the effect, so an
 * effect is never unaudited (a failed intent write stops it; a failed after-entry leaves the intent as the trail, and a retry reports `not_in_dlq`).
 */
export class DlqAdmin implements DlqAdminPort {
  constructor(private readonly worker: RoleSqlClient<"outlet_worker">, private readonly app: RoleSqlClient<"outlet_app">, private readonly audit: AuditAppendPort, private readonly now: () => Date = () => new Date()) {}

  private dlq(p: Principal): DlqReplay {
    return new DlqReplay(contextClient(this.worker, { kind: "worker", marketId: p.marketId, job: "outbox.relay" }), this.now);
  }

  private actor(p: Principal): string {
    if (p.userId === undefined) throw Problems.forbidden();
    return p.userId;
  }

  async list(p: Principal, q: { readonly limit: number; readonly cursor?: string | undefined }): Promise<DlqPage> {
    let after: string | undefined;
    if (q.cursor !== undefined) {
      after = decodeCursor(q.cursor, 1)[0];
      if (after === undefined || !UUID.test(after)) throw Problems.badRequest("cursor-invalid");
    }
    const page = await this.dlq(p).list(p.marketId, after, q.limit);
    return {
      items: page.items.map((i) => ({ id: i.id, event_id: i.messageId, event_type: i.eventType, attempts: i.attempts, last_error: i.lastError, dead_lettered_at: i.deadLetteredAt.toISOString() })),
      next_cursor: page.nextCursor === null ? null : encodeCursor(page.nextCursor),
    };
  }

  types(p: Principal, ids: readonly string[]): Promise<ReadonlyMap<string, string>> {
    return this.dlq(p).lookup(p.marketId, ids);
  }

  async replay(p: Principal, ids: readonly string[]): Promise<DlqActionResult> {
    const actor = this.actor(p);
    await this.intent(p, actor, "dlq.replay_requested", ids, {});
    const r = result(await this.dlq(p).replay(p.marketId, ids));
    if (r.changed > 0) {
      await withDbContext(this.app, { kind: "user", marketId: p.marketId, userId: actor }, (tx) =>
        this.append(tx, p, actor, "dlq.replayed", r, {}),
      );
    }
    return r;
  }

  async discard(p: Principal, ids: readonly string[], reason: DiscardReasonCode): Promise<DlqActionResult> {
    const actor = this.actor(p);
    await this.intent(p, actor, "dlq.discard_requested", ids, { reasonCode: reason });
    return result(await this.dlq(p).discard(p.marketId, ids, reason));
  }

  async record(p: Principal, r: DlqActionResult, extra: { readonly reasonCode: DiscardReasonCode; readonly approvalRequestId?: string }, tx?: Queryable): Promise<void> {
    if (r.changed === 0) return;
    const actor = this.actor(p);
    const body = (t: Queryable): Promise<void> => this.append(t, p, actor, "dlq.discarded", r, { reasonCode: extra.reasonCode, ...(extra.approvalRequestId === undefined ? {} : { approvalRequestId: extra.approvalRequestId }) });
    if (tx !== undefined) return body(tx);
    await withDbContext(this.app, { kind: "user", marketId: p.marketId, userId: actor }, body);
  }

  private async intent(p: Principal, actor: string, action: "dlq.replay_requested" | "dlq.discard_requested", ids: readonly string[], extra: Record<string, string>): Promise<void> {
    const wanted = [...new Set(ids)];
    await withDbContext(this.app, { kind: "user", marketId: p.marketId, userId: actor }, (tx) =>
      this.audit.appendIn(tx, {
        marketId: p.marketId, actorType: "staff", actorId: actor, action, targetType: "dlq_batch", targetId: wanted[0] ?? p.marketId,
        diff: { after: { ids: wanted, count: wanted.length, ...extra } }, ipHash: null, deviceId: null, requestId: null,
      }),
    );
  }

  private async append(tx: Queryable, p: Principal, actor: string, action: "dlq.replayed" | "dlq.discarded", r: DlqActionResult, extra: Record<string, string>): Promise<void> {
    const ids = r.results.filter((x) => APPLIED(x.outcome)).map((x) => x.id);
    await this.audit.appendIn(tx, {
      marketId: p.marketId, actorType: "staff", actorId: actor, action, targetType: "dlq_batch", targetId: ids[0] ?? p.marketId,
      diff: { after: { ids, count: ids.length, skipped: r.results.length - ids.length, ...extra } }, ipHash: null, deviceId: null, requestId: null,
    });
  }
}
