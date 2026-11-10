import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { decodeCursor, encodeCursor } from "../../platform/cursor.js";
import type { PageQuery, ReturnLineRow, ReturnPage, ReturnReaderPort, ReturnRow } from "./services.js";

interface Row {
  id: string; seller_order_id: string; status: string; reason_code: string; fault: string; window_basis: string; delivered_at_snapshot: Date; window_ends_at: Date; method: string; resolution: string;
  rejection_reason: string | null; received_at: Date | null; inspection_due_at: Date | null; refund_due_at: Date | null; created_at: Date;
}
interface ItemRow { id: string; return_request_id: string; order_line_id: string; qty: number; condition_received: string | null; restock_decision: string | null }

const COLS = `id, seller_order_id, status, reason_code, fault, window_basis, delivered_at_snapshot, window_ends_at, method, resolution, received_at, inspection_due_at, refund_due_at, created_at,
  CASE WHEN status IN ('REJECTED', 'DISPUTED') THEN (SELECT i.reason_code FROM return_inspections i WHERE i.return_request_id = return_requests.id AND i.result = 'rejected' ORDER BY i.inspected_at DESC LIMIT 1) END AS rejection_reason`;
const d = (v: Date | null): Date | null => (v === null ? null : new Date(v));

const assemble = (r: Row, items: readonly ItemRow[]): ReturnRow => ({
  id: r.id, sellerOrderId: r.seller_order_id, status: r.status, reasonCode: r.reason_code, fault: r.fault, windowBasis: r.window_basis, deliveredAtSnapshot: new Date(r.delivered_at_snapshot),
  windowEndsAt: new Date(r.window_ends_at), method: r.method, resolution: r.resolution, receivedAt: d(r.received_at), inspectionDueAt: d(r.inspection_due_at), refundDueAt: d(r.refund_due_at), rejectionReason: r.rejection_reason, createdAt: new Date(r.created_at),
  lines: items.filter((i) => i.return_request_id === r.id).map((i): ReturnLineRow => ({ id: i.id, orderLineId: i.order_line_id, qty: i.qty, conditionReceived: i.condition_received, restockDecision: i.restock_decision })),
});

type Ctx = { readonly kind: "user"; readonly userId: string } | { readonly kind: "store"; readonly storeId: string };

export class ReturnReader implements ReturnReaderPort {
  constructor(private readonly client: RoleSqlClient<"outlet_app">, private readonly marketId: string) {}

  private run<T>(c: Ctx, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.client, c.kind === "user" ? { kind: "user", marketId: this.marketId, userId: c.userId } : { kind: "store", marketId: this.marketId, storeId: c.storeId }, fn);
  }

  private async page(c: Ctx, q: PageQuery): Promise<ReturnPage> {
    const after = q.cursor === undefined ? undefined : decodeCursor(q.cursor, 2);
    return this.run(c, async (tx) => {
      const rows = (
        await tx.query<Row>(
          `SELECT ${COLS} FROM return_requests
            WHERE ($1::text IS NULL OR status = $1) AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
            ORDER BY created_at DESC, id DESC LIMIT $4`,
          [q.status ?? null, after?.[0] ?? null, after?.[1] ?? null, q.limit + 1],
        )
      ).rows;
      const shown = rows.slice(0, q.limit);
      const items = shown.length === 0 ? [] : (await tx.query<ItemRow>("SELECT id, return_request_id, order_line_id, qty, condition_received, restock_decision FROM return_items WHERE return_request_id = ANY($1::uuid[]) ORDER BY id", [shown.map((r) => r.id)])).rows;
      const last = shown[shown.length - 1];
      return { items: shown.map((r) => assemble(r, items)), nextCursor: rows.length > q.limit && last !== undefined ? encodeCursor(new Date(last.created_at).toISOString(), last.id) : null };
    });
  }

  private one(c: Ctx, id: string): Promise<ReturnRow | null> {
    return this.run(c, async (tx) => {
      const r = (await tx.query<Row>(`SELECT ${COLS} FROM return_requests WHERE id = $1`, [id])).rows[0];
      if (r === undefined) return null;
      const items = (await tx.query<ItemRow>("SELECT id, return_request_id, order_line_id, qty, condition_received, restock_decision FROM return_items WHERE return_request_id = $1 ORDER BY id", [id])).rows;
      return assemble(r, items);
    });
  }

  listOwn(userId: string, q: PageQuery): Promise<ReturnPage> {
    return this.page({ kind: "user", userId }, q);
  }
  getOwn(userId: string, id: string): Promise<ReturnRow | null> {
    return this.one({ kind: "user", userId }, id);
  }
  listStore(storeId: string, q: PageQuery): Promise<ReturnPage> {
    return this.page({ kind: "store", storeId }, q);
  }
  getStore(storeId: string, id: string): Promise<ReturnRow | null> {
    return this.one({ kind: "store", storeId }, id);
  }

  async linesBelong(userId: string, sellerOrderId: string, lineIds: readonly string[]): Promise<boolean> {
    const n = await this.run({ kind: "user", userId }, async (tx) =>
      (await tx.query<{ n: string }>("SELECT count(*)::text AS n FROM order_lines WHERE seller_order_id = $1 AND id = ANY($2::uuid[])", [sellerOrderId, lineIds])).rows[0]?.n ?? "0",
    );
    return Number(n) === new Set(lineIds).size;
  }
}
