import { assertRuntimeRole, loadMigrations } from "@outlet/db";
import type { Queryable } from "@outlet/db";

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: { readonly db: CheckState; readonly migrations: CheckState; readonly role: CheckState; readonly lifecycle: CheckState };
}
export type CheckState = "ok" | "failed" | "skipped";

/**
 * /ready: draining → not ready; `SELECT 1` every time; migrations applied and the runtime-role guard (ADR-0011) are
 * checked until they first pass and then cached (they cannot regress without a deploy), so a probe is one query.
 */
export class ReadinessProbe {
  private schemaOk = false;
  private roleOk = false;

  constructor(
    private readonly db: Queryable,
    private readonly lifecycle: { readonly draining: boolean },
    private readonly expectedMigrations: () => Promise<readonly string[]> = async () => (await loadMigrations()).map((m) => m.name),
  ) {}

  async check(): Promise<ReadinessReport> {
    if (this.lifecycle.draining) return { ready: false, checks: { lifecycle: "failed", db: "skipped", migrations: "skipped", role: "skipped" } };
    const db = await this.ping();
    if (db !== "ok") return { ready: false, checks: { lifecycle: "ok", db, migrations: "skipped", role: "skipped" } };
    if (!this.schemaOk) this.schemaOk = await this.migrationsApplied();
    if (!this.roleOk) this.roleOk = await assertRuntimeRole(this.db, "outlet_app").then(() => true, () => false);
    const migrations: CheckState = this.schemaOk ? "ok" : "failed";
    const role: CheckState = this.roleOk ? "ok" : "failed";
    return { ready: this.schemaOk && this.roleOk, checks: { lifecycle: "ok", db, migrations, role } };
  }

  private async ping(): Promise<CheckState> {
    try {
      await this.db.query("SELECT 1 AS ok");
      return "ok";
    } catch {
      return "failed";
    }
  }

  private async migrationsApplied(): Promise<boolean> {
    try {
      const applied = new Set((await this.db.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name));
      return (await this.expectedMigrations()).every((m) => applied.has(m));
    } catch {
      return false;
    }
  }
}
