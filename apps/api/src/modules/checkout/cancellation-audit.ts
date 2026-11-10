import { PgAuditStore } from "@outlet/audit-log";
import type { RoleSqlClient } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import type { CancellationAuditEntry, CancellationAuditPort } from "@outlet/checkout";

/**
 * Appends the cancellation to the hash-chained audit_log INSIDE the cancel transaction (outlet_app may only INSERT; head via SECURITY DEFINER;
 * the insert policy pins the market only, so the shopper's user context of the cancel transaction is fine for a store-member actor too).
 */
export class PgCancellationAudit implements CancellationAuditPort {
  private readonly store: PgAuditStore;
  constructor(app: RoleSqlClient<"outlet_app">) {
    this.store = new PgAuditStore(app);
  }
  async appendIn(tx: Queryable, e: CancellationAuditEntry): Promise<void> {
    await this.store.appendIn(tx, { marketId: e.marketId, actorType: e.actorType, actorId: e.actorId, action: e.action, targetType: e.targetType, targetId: e.targetId, diff: e.diff, ipHash: null, deviceId: null, requestId: null });
  }
}
