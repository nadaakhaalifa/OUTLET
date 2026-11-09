import type { AuditEntryInput } from "@outlet/audit-log";
import type { SqlClient } from "@outlet/db";
import { createTestClient, roleClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import type { Principal } from "@outlet/policy";
import { createAdminAccess } from "../src/index.js";
import type { AdminAccess } from "../src/index.js";

export const T0 = new Date("2026-11-08T10:00:00Z");
export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export interface Env {
  readonly client: SqlClient;
  readonly svc: AdminAccess;
  readonly audits: AuditEntryInput[];
  readonly setNow: (d: Date) => void;
  readonly advance: (ms: number) => void;
  readonly seedGrant: (staffId: string, role: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

export const makeEnv = async (): Promise<Env> => {
  const { client, close } = await createTestClient();
  let now = new Date(T0);
  const audits: AuditEntryInput[] = [];
  const svc = createAdminAccess({
    db: roleClient(client, "outlet_app"),
    audit: { appendIn: (_tx, e) => { audits.push(e); return Promise.resolve(); } },
    clock: () => now,
    thresholdMinor: 1_000_000n,
  });
  return {
    client, svc, audits, close,
    setNow: (d) => { now = d; },
    advance: (ms) => { now = new Date(now.getTime() + ms); },
    seedGrant: async (staffId, role) => {
      await client.query(
        "INSERT INTO staff_role_assignments (id, staff_id, role_code, market_id, granted_by, reason, starts_at, expires_at, created_at) VALUES ($1,$2,$3,'EG',$2,'seed','2020-01-01','2100-01-01','2020-01-01')",
        [uuidv7(), staffId, role],
      );
    },
  };
};

export const admin = (id: string, roles: string[], breakGlass = false): Principal => ({ kind: "admin", userId: id, marketId: "EG", roles, scopes: [], ...(breakGlass ? { breakGlass: true } : {}) });
