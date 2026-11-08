/** Business-process tags set as Postgres application_name per pool (master prompt 20.2, T8). */
export const PG_PROCESS_NAMES = [
  "checkout.reserve",
  "checkout.write",
  "catalog.read",
  "analytics",
  "worker.outbox",
  /** Pre-auth endpoints on the outlet_auth pool (ADR-0011). */
  "auth",
  /** Background jobs on the outlet_worker pool (ADR-0011). */
  "worker",
  "migrator",
] as const;
export type PgProcessName = (typeof PG_PROCESS_NAMES)[number];

export const pgConnectionTag = (processName: PgProcessName): string => {
  if (!(PG_PROCESS_NAMES as readonly string[]).includes(processName)) {
    throw new Error(`unknown pg process name: ${processName}`);
  }
  return processName;
};
