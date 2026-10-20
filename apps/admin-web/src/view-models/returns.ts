import type { ApprovalWire } from "../api/schemas";
import { parseMinor } from "../lib/format";

export interface RefundApprovalRow {
  readonly id: string;
  readonly subjectId: string;
  readonly amountMinor: bigint | null;
  readonly state: ApprovalWire["state"];
  readonly expiresAtMs: number;
}

/**
 * The Admin API has no returns or disputes list endpoint yet (only POST /v1/admin/disputes/{id}/resolve is in the
 * OpenAPI draft, with no read model). What IS available and money-relevant is the dual-approval stream for refunds,
 * so this screen shows that and says plainly that the dispute list is not available. No sample rows, ever.
 */
export function refundApprovals(items: readonly ApprovalWire[]): readonly RefundApprovalRow[] {
  return items
    .filter((a) => a.kind === "refund")
    .map((a): RefundApprovalRow => ({
      id: a.id,
      subjectId: a.subject_id,
      amountMinor: a.amount_minor === null ? null : parseMinor(a.amount_minor),
      state: a.state,
      expiresAtMs: Date.parse(a.expires_at),
    }))
    .sort((a, b) => a.expiresAtMs - b.expiresAtMs || a.id.localeCompare(b.id));
}
