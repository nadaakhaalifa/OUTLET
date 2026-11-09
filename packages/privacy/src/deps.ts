import type { Queryable, SqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import type { OutboxWriter } from "@outlet/outbox";

/** Structural port satisfied by PgAuditStore (@outlet/audit-log); bind it to the same outlet_app client as `db`. */
export interface AuditAppendPort {
  appendIn(
    tx: Queryable,
    input: {
      readonly marketId: string;
      readonly actorType: "user" | "staff" | "store_member" | "system";
      readonly actorId: string | null;
      readonly action: string;
      readonly targetType: string;
      readonly targetId: string;
      readonly diff: { readonly before?: unknown; readonly after?: unknown } | null;
      readonly ipHash: string | null;
      readonly deviceId: string | null;
      readonly requestId: string | null;
    },
  ): Promise<unknown>;
}

export interface PrivacyDeps {
  /** Required by BreachRegister (audit chain entry in the same transaction as every breach change). */
  readonly audit?: AuditAppendPort;
  readonly db: SqlClient;
  readonly outbox: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface ResolvedDeps {
  readonly audit: AuditAppendPort | undefined;
  readonly db: SqlClient;
  readonly outbox: OutboxWriter;
  readonly now: () => Date;
  readonly newId: () => string;
}

export const resolveDeps = (d: PrivacyDeps): ResolvedDeps => ({
  audit: d.audit,
  db: d.db,
  outbox: d.outbox,
  now: d.now ?? (() => new Date()),
  newId: d.newId ?? uuidv7,
});

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
