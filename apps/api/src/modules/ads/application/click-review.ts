import type { ClickRecord, ClickReviewDecision, ClickReviewRecord } from "../domain/ports";
import type { AdsDeps } from "./shared";

export const encodeClickCursor = (atMs: number, id: string): string => Buffer.from(`${atMs}.${id}`, "utf8").toString("base64url");
export function decodeClickCursor(raw: string): { atMs: number; id: string } | null {
  const m = /^(\d{1,15})\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(Buffer.from(raw, "base64url").toString("utf8"));
  return m === null ? null : { atMs: Number(m[1]), id: m[2] ?? "" };
}

export class ListInvalidClicks {
  constructor(private readonly d: AdsDeps) {}
  async execute(limit: number, after: { atMs: number; id: string } | null): Promise<{ items: readonly ClickRecord[]; nextCursor: string | null }> {
    const rows = await this.d.store.listInvalidClickQueue({ limit: limit + 1, after });
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > limit && last !== undefined ? encodeClickCursor(last.atMs, last.id) : null };
  }
}

export type ReviewResult =
  | { readonly kind: "decided" | "replayed"; readonly review: ClickReviewRecord }
  | { readonly kind: "conflict" | "not_found" | "not_reviewable" };

export class DecideInvalidClick {
  constructor(private readonly d: AdsDeps) {}
  async execute(i: { clickId: string; decision: ClickReviewDecision; reasonCode: string; actorId: string }): Promise<ReviewResult> {
    const r = await this.d.store.decideClickReview({ clickId: i.clickId, decision: i.decision, reasonCode: i.reasonCode, decidedBy: i.actorId, decidedAtMs: this.d.clock.nowMs() });
    return r.kind === "decided" || r.kind === "replayed" ? { kind: r.kind, review: r.review } : { kind: r.kind };
  }
}
