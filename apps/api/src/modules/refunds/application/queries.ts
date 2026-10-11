import { sloState, type SloState } from "../domain/bridge";
import type { ClockPort, RefundRecord, RefundStore } from "../domain/ports";

export interface RefundView {
  readonly refund: RefundRecord;
  readonly slo: SloState | null;
}

const viewOf = (r: RefundRecord, nowMs: number): RefundView => ({
  refund: r,
  slo:
    r.returnReceivedAtMs === null
      ? null
      : sloState({
          receivedAtMs: r.returnReceivedAtMs,
          initiatedAtMs: r.initiatedAtMs,
          paidAtMs: r.completedAtMs,
          nowMs,
        }),
});

export class GetMyRefund {
  constructor(
    private readonly store: RefundStore,
    private readonly clock: ClockPort,
  ) {}
  /** A refund that belongs to someone else is indistinguishable from one that does not exist. */
  async execute(userId: string, refundId: string): Promise<RefundView | null> {
    const r = await this.store.get(refundId);
    return r === null || r.userId !== userId ? null : viewOf(r, this.clock.nowMs());
  }
}

export class ListMyRefunds {
  constructor(
    private readonly store: RefundStore,
    private readonly clock: ClockPort,
  ) {}
  async execute(userId: string, after: { createdAtMs: number; id: string } | null, limit: number): Promise<{ items: RefundView[]; hasMore: boolean }> {
    const rows = await this.store.listForUser(userId, { after, limit: limit + 1 });
    const now = this.clock.nowMs();
    return { items: rows.slice(0, limit).map((r) => viewOf(r, now)), hasMore: rows.length > limit };
  }
}
