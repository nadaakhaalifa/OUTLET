import type { ReportReason, UgcTargetType } from "../domain/bridge";
import { changeStatus } from "./moderation";
import type { ReviewDeps } from "./shared";

export type ReportResult =
  | { readonly kind: "accepted" }
  | { readonly kind: "not_found" }
  | { readonly kind: "own_content" }
  | { readonly kind: "rate_limited" };

const DAY_MS = 86_400_000;

/**
 * Report flow for every UGC item. Only visible (published) items can be reported, so the
 * endpoint is not a probe for held content. A repeat report by the same user is accepted and
 * counted once. Enough distinct reporters hold the item for a human.
 */
export class ReportContent {
  constructor(private readonly d: ReviewDeps) {}

  async execute(input: {
    readonly reporterId: string;
    readonly targetType: UgcTargetType;
    readonly targetId: string;
    readonly reason: ReportReason;
  }): Promise<ReportResult> {
    const item = await this.d.store.getUgc(input.targetType, input.targetId);
    if (item === null || item.status !== "PUBLISHED") return { kind: "not_found" };
    if (item.authorUserId === input.reporterId) return { kind: "own_content" };
    const now = this.d.clock.nowMs();
    const recent = await this.d.store.countReportsBy(input.reporterId, now - DAY_MS);
    if (recent >= this.d.cfg.reportsPerReporterPerDay) return { kind: "rate_limited" };
    const added = await this.d.store.addReport(
      {
        id: this.d.ids.uuidV7(),
        targetType: input.targetType,
        targetId: input.targetId,
        reporterId: input.reporterId,
        reason: input.reason,
        createdAtMs: now,
      },
      [{ type: "ugc.reported", targetType: input.targetType, targetId: input.targetId, reason: input.reason }],
    );
    if (added === "duplicate") return { kind: "accepted" };
    const distinct = await this.d.store.countDistinctReporters(input.targetType, input.targetId);
    if (distinct >= this.d.cfg.reportsToHold) {
      await changeStatus(this.d, item, "HELD", { kind: "reports", id: null, reason: "reported" });
    }
    return { kind: "accepted" };
  }
}
