import { PgAuditStore } from "@outlet/audit-log";
import { contextClient } from "@outlet/db";
import type { RoleSqlClient } from "@outlet/db";
import type { CancellationAuditPort } from "@outlet/checkout";

/** Appends the cancellation to the hash-chained audit_log as the acting shopper (outlet_app may only INSERT; head via SECURITY DEFINER). */
export class PgCancellationAudit implements CancellationAuditPort {
  constructor(private readonly app: RoleSqlClient<"outlet_app">) {}
  async append(e: Parameters<CancellationAuditPort["append"]>[0]): Promise<void> {
    const store = new PgAuditStore(contextClient(this.app, { kind: "user", marketId: e.marketId, userId: e.actorId }));
    await store.append({ marketId: e.marketId, actorType: e.actorType, actorId: e.actorId, action: e.action, targetType: e.targetType, targetId: e.targetId, diff: e.diff, ipHash: null, deviceId: null, requestId: null });
  }
}
