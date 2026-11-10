import type { RoleSqlClient } from "@outlet/db";
import { PgAttentionReader } from "@outlet/ops-attention";
import type { AttentionCounts, AttentionItem } from "@outlet/ops-attention";
import type { Principal } from "@outlet/policy";
import { ProblemError, Problems } from "../../platform/problem.js";
import type { AttentionItemDto, AttentionResolveInput } from "./dto-dashboard.js";
import type { AuditAppendPort } from "./ports.js";

export interface AttentionPageDto { readonly items: AttentionItemDto[]; readonly next_cursor: string | null }

export interface AttentionAdminPort {
  list(p: Principal, q: { readonly limit: number; readonly cursor?: string | undefined }): Promise<AttentionPageDto>;
  /** 404 for an id outside the market, 409 `attention-conflict` for a resolved item. Already acked = unchanged success. */
  ack(p: Principal, id: string): Promise<AttentionItemDto>;
  /** 404, or 409 `attention-conflict` when the item was resolved with another code. */
  resolve(p: Principal, id: string, code: AttentionResolveInput["resolution_code"]): Promise<AttentionItemDto>;
  /** Dashboard tile. */
  countOpen(p: Principal): Promise<AttentionCounts>;
}

const dto = (i: AttentionItem): AttentionItemDto => ({
  id: i.id, kind: i.kind, ref_type: i.refType, ref_id: i.refId, payload: { ...i.payload }, status: i.status, created_at: i.createdAt,
  acked_by: i.ackedBy, acked_at: i.ackedAt, resolved_at: i.resolvedAt, resolution_code: i.resolutionCode,
});

/**
 * Staff side of the ops attention queue. The route proves the staff permission (`attention.read` / `attention.write`); every write appends its audit entry
 * through `AuditAppendPort.appendIn` inside the same outlet_app transaction as the status update (no audit, no change). The payload is not copied into the audit diff.
 */
export class AttentionAdmin implements AttentionAdminPort {
  constructor(private readonly db: RoleSqlClient<"outlet_app">, private readonly audit: AuditAppendPort, private readonly now: () => Date = () => new Date()) {}

  private reader(p: Principal): PgAttentionReader {
    return new PgAttentionReader(this.db, p.marketId, this.now);
  }

  async list(p: Principal, q: { readonly limit: number; readonly cursor?: string | undefined }): Promise<AttentionPageDto> {
    // The reader's cursor is already opaque base64url (an undecodable one reads as "no cursor").
    const page = await this.reader(p).listOpen({ limit: q.limit, ...(q.cursor === undefined ? {} : { cursor: q.cursor }) }, p.userId);
    return { items: page.items.map(dto), next_cursor: page.nextCursor };
  }

  async ack(p: Principal, id: string): Promise<AttentionItemDto> {
    const actor = this.actor(p);
    const r = await this.reader(p).ack(id, actor, (tx, item, before) =>
      this.audit.appendIn(tx, {
        marketId: p.marketId, actorType: "staff", actorId: actor, action: "attention.acked", targetType: "attention_item", targetId: id,
        diff: { before: { status: before }, after: { status: item.status, kind: item.kind } }, ipHash: null, deviceId: null, requestId: null,
      }).then(() => undefined),
    );
    return this.outcome(r);
  }

  async resolve(p: Principal, id: string, code: AttentionResolveInput["resolution_code"]): Promise<AttentionItemDto> {
    const actor = this.actor(p);
    const r = await this.reader(p).resolve(id, actor, code, (tx, item, before) =>
      this.audit.appendIn(tx, {
        marketId: p.marketId, actorType: "staff", actorId: actor, action: "attention.resolved", targetType: "attention_item", targetId: id,
        diff: { before: { status: before }, after: { status: item.status, kind: item.kind, resolutionCode: code } }, ipHash: null, deviceId: null, requestId: null,
      }).then(() => undefined),
    );
    return this.outcome(r);
  }

  countOpen(p: Principal): Promise<AttentionCounts> {
    return this.reader(p).countOpen(p.userId);
  }

  private actor(p: Principal): string {
    if (p.userId === undefined) throw Problems.forbidden();
    return p.userId;
  }

  private outcome(r: Awaited<ReturnType<PgAttentionReader["ack"]>>): AttentionItemDto {
    if (r.outcome === "not_found") throw Problems.notFound();
    if (r.outcome === "conflict") throw new ProblemError(409, "attention-conflict", "The item was already resolved");
    return dto(r.item);
  }
}
