import type { Queryable } from "@outlet/db";

export type RetentionAction = "delete" | "pseudonymise" | "aggregate";

export interface PurgePlanItem {
  readonly policyCode: string;
  readonly table: string;
  readonly action: RetentionAction;
  /** Rows with timestamp older than this are due. */
  readonly cutoff: Date;
  readonly dueCount: number;
  /** False while the owning module has not shipped its table; nothing is due then. */
  readonly tableExists: boolean;
  readonly verifyRef: string | null;
}

interface PolicyRow {
  code: string;
  table_name: string;
  timestamp_column: string;
  action: RetentionAction;
  verify_ref: string | null;
  cutoff: Date;
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** Read-only: counts rows past each retention policy. Executing the purge is a later step. */
export const purgePlan = async (db: Queryable, now: Date): Promise<PurgePlanItem[]> => {
  const policies = await db.query<PolicyRow>(
    "SELECT code, table_name, timestamp_column, action, verify_ref, ($1::timestamptz - retain_for) AS cutoff FROM retention_policies ORDER BY code",
    [now],
  );
  const plan: PurgePlanItem[] = [];
  for (const p of policies.rows) {
    const base = { policyCode: p.code, table: p.table_name, action: p.action, cutoff: p.cutoff, verifyRef: p.verify_ref };
    const exists = await db.query<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS ok`,
      [p.table_name, p.timestamp_column],
    );
    if (!exists.rows[0]?.ok || !IDENT.test(p.table_name) || !IDENT.test(p.timestamp_column)) {
      plan.push({ ...base, dueCount: 0, tableExists: false });
      continue;
    }
    const n = await db.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM "${p.table_name}" WHERE "${p.timestamp_column}" < $1`,
      [p.cutoff],
    );
    plan.push({ ...base, dueCount: Number(n.rows[0]?.n ?? 0), tableExists: true });
  }
  return plan;
};
