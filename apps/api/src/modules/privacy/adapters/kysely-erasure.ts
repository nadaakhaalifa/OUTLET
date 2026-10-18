import { sql } from "kysely";
import type { InventoryTable, TableErasurePlan } from "../domain/bridge";
import type { ErasureExecutorPort, ObjectStorePort } from "../domain/ports";
import type { PrivacyDb } from "./kysely-store";
import { SchemaCatalog, inSystemTx, isUuid, locatorFor, type SchemaSnapshot } from "./subject-tables";

/**
 * Retention keys (docs/privacy/data_inventory.yaml) whose rows must survive an account deletion:
 * tax and order records, financial webhooks, delivery evidence, audit, consent proof, DSAR proof.
 * A table with any field under one of them is never row-deleted, only column-scrubbed.
 */
const LEGAL_RETENTION: ReadonlySet<string> = new Set([
  "orders_tax_records",
  "raw_webhooks_financial",
  "delivery_records",
  "returns_evidence",
  "kyc_records",
  "audit_log",
  "consent_evidence",
  "dsar_records",
  "stock_movement_evidence",
]);

const FK_VIOLATION = "23503";
const MAX_PASSES = 6;

/** Counts only (table names are P0 schema names). Never ids, never values. */
export interface ErasureReport {
  readonly deleted: Readonly<Record<string, number>>;
  readonly scrubbed: Readonly<Record<string, number>>;
  /** Table not present in this deployment's schema. */
  readonly missingTables: readonly string[];
  /** No way to attribute rows to the subject (no user key). Residual gap. */
  readonly noLocator: readonly string[];
  /** Append-only evidence tables, kept as written (the subject key is a surrogate id after tombstoning). */
  readonly immutableTables: readonly string[];
  /** Personal NOT NULL columns that could neither be nulled nor pseudonymised in place. */
  readonly unscrubbableColumns: readonly string[];
  readonly artifactsDeleted: number;
}

export interface KyselyErasureOptions {
  readonly objectStore: ObjectStorePort;
  /** Resolved inventory: only P2/P3 fields are ever rewritten. */
  readonly inventory: readonly InventoryTable[];
  readonly onReport?: (report: ErasureReport) => void;
}

const TEXTUAL = new Set(["text", "character varying", "character"]);

function isFkViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === FK_VIOLATION;
}

/**
 * Applies an erasure plan to Postgres.
 *
 *  - action `erase` and no legal retention: the subject's rows are deleted (children first: foreign
 *    key violations are retried in later passes, and a request that cannot make progress fails so it
 *    parks for the DPO instead of reporting a false success).
 *  - `pseudonymise` / `retain_by_law` / legally retained: rows are kept; P2/P3 columns are nulled, or
 *    replaced by the pseudonym when textual and unbounded. uuid columns (user_id and other ids) are
 *    never rewritten: the retained `users` row is tombstoned instead, so the surrogate id carries
 *    no identity ("pseudonymise by tombstone").
 *  - fields tagged retain_legal are never touched. Financial and tax rows inside retention survive.
 * Idempotent and resumable: every statement is a no-op on a second run; a crash resumes by re-running.
 * The subject's export archives are deleted first (a deletion of an absent key is a no-op).
 */
export class KyselyErasureExecutor implements ErasureExecutorPort {
  private readonly catalog: SchemaCatalog;
  private readonly personal: ReadonlySet<string>;
  private readonly retainedByLaw: ReadonlySet<string>;

  constructor(
    private readonly db: PrivacyDb,
    private readonly options: KyselyErasureOptions,
  ) {
    this.catalog = new SchemaCatalog(db);
    const personal = new Set<string>();
    const retained = new Set<string>();
    for (const t of options.inventory) {
      for (const f of t.fields) {
        if (f.piiClass === "P2" || f.piiClass === "P3") personal.add(`${t.name}.${f.name}`);
        if (f.retention !== null && LEGAL_RETENTION.has(f.retention)) retained.add(t.name);
      }
    }
    this.personal = personal;
    this.retainedByLaw = retained;
  }

  async execute(input: {
    readonly userId: string;
    readonly pseudonym: string;
    readonly plan: Parameters<ErasureExecutorPort["execute"]>[0]["plan"];
    readonly artifactKeys?: readonly string[];
  }): Promise<void> {
    if (!isUuid(input.userId)) throw new Error("erasure subject must be a uuid");
    if (input.pseudonym.length === 0) throw new Error("pseudonym required");
    const schema = await this.catalog.load();
    const keys = input.artifactKeys ?? [];
    // A deployment without an object store never wrote an archive, so there is nothing to delete.
    let artifactsDeleted = 0;
    if (this.options.objectStore.configured !== false) {
      for (const k of keys) {
        await this.options.objectStore.delete(k);
        artifactsDeleted += 1;
      }
    }
    const report = {
      deleted: {} as Record<string, number>,
      scrubbed: {} as Record<string, number>,
      missingTables: [] as string[],
      noLocator: [] as string[],
      immutableTables: [] as string[],
      unscrubbableColumns: [] as string[],
      artifactsDeleted,
    };
    let pending = input.plan.tables.filter((t) => t.storage === "platform_db" && (t.action !== "none" || t.table === "users"));
    for (let pass = 0; pass < MAX_PASSES && pending.length > 0; pass += 1) {
      const retry: TableErasurePlan[] = [];
      for (const t of pending) {
        try {
          await this.eraseTable(t, input.userId, input.pseudonym, schema, report);
        } catch (e) {
          if (!isFkViolation(e)) throw e;
          retry.push(t);
        }
      }
      if (retry.length === pending.length) {
        throw new Error(`erasure blocked by foreign keys on ${retry.map((t) => t.table).sort().join(", ")}`);
      }
      pending = retry;
    }
    if (pending.length > 0) throw new Error("erasure did not converge; will retry");
    this.options.onReport?.({
      ...report,
      missingTables: [...new Set(report.missingTables)].sort(),
      noLocator: [...new Set(report.noLocator)].sort(),
      immutableTables: [...new Set(report.immutableTables)].sort(),
      unscrubbableColumns: [...new Set(report.unscrubbableColumns)].sort(),
    });
  }

  private async eraseTable(
    plan: TableErasurePlan,
    userId: string,
    pseudonym: string,
    schema: SchemaSnapshot,
    report: {
      deleted: Record<string, number>;
      scrubbed: Record<string, number>;
      missingTables: string[];
      noLocator: string[];
      immutableTables: string[];
      unscrubbableColumns: string[];
    },
  ): Promise<void> {
    const table = plan.table;
    const cols = schema.tables.get(table);
    if (cols === undefined) {
      report.missingTables.push(table);
      return;
    }
    const where = locatorFor(table, cols);
    if (where === undefined) {
      report.noLocator.push(table);
      return;
    }
    if (schema.immutable.has(table)) {
      report.immutableTables.push(table);
      return;
    }
    const isUsers = table === "users";
    const wholeRowPersonal = plan.action === "erase" && !this.retainedByLaw.has(table) && !isUsers;
    if (wholeRowPersonal) {
      const n = await inSystemTx(this.db, false, async (trx) => {
        const r = await sql`delete from ${sql.table(table)} as t where ${where(userId)}`.execute(trx);
        return Number(r.numAffectedRows ?? 0n);
      });
      report.deleted[table] = (report.deleted[table] ?? 0) + n;
      return;
    }

    const sets: ReturnType<typeof sql>[] = [];
    const scrub = (field: string, mode: "null" | "pseudonym"): void => {
      const c = cols.get(field);
      if (c === undefined || field === "id" || c.type === "uuid") return;
      if (!this.personal.has(`${table}.${field}`)) return;
      if (mode === "pseudonym" && TEXTUAL.has(c.type) && c.maxLength === null) {
        sets.push(sql`${sql.ref(field)} = ${pseudonym}`);
      } else if (c.nullable) {
        sets.push(sql`${sql.ref(field)} = null`);
      } else {
        report.unscrubbableColumns.push(`${table}.${field}`);
      }
    };
    for (const f of plan.eraseFields) scrub(f, "null");
    for (const f of plan.pseudonymiseFields) scrub(f, "pseudonym");
    if (isUsers) {
      sets.push(sql`status = 'deleted'`, sql`deleted_at = coalesce(deleted_at, now())`);
    }
    if (sets.length === 0) return;
    const n = await inSystemTx(this.db, false, async (trx) => {
      const r = await sql`update ${sql.table(table)} as t set ${sql.join(sets)} where ${where(userId)}`.execute(trx);
      return Number(r.numAffectedRows ?? 0n);
    });
    report.scrubbed[table] = (report.scrubbed[table] ?? 0) + n;
  }
}
