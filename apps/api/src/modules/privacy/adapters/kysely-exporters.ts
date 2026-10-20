import { sql } from "kysely";
import type { ExporterDescriptor } from "../domain/bridge";
import type { ExportRow, ExportSection, ExporterPort, FieldDecryptPort } from "../domain/ports";
import type { PrivacyDb } from "./kysely-store";
import {
  SchemaCatalog,
  TABLE_SPECS,
  inSystemTx,
  isUuid,
  locatorFor,
  type ColumnInfo,
  type JsonRow,
} from "./subject-tables";

const dec = new TextDecoder();

/** `to_jsonb` renders bytea as the hex string `\x...`. */
function bytesOf(v: unknown): Uint8Array | null {
  if (typeof v !== "string" || !v.startsWith("\\x")) return null;
  return new Uint8Array(Buffer.from(v.slice(2), "hex"));
}

function plain(text: string): unknown {
  const t = text.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Exporter for one manifest group, reading the owning modules' tables with the subject's id
 * (read-only transaction, system role). P2/P3 bytea fields are opened ONLY through the
 * FieldDecryptPort; every other bytea column (hashes, ciphertext without a known AAD) is dropped,
 * and so are credentials and raw provider bodies listed in TABLE_SPECS.omit.
 * A declared table that does not exist in the schema, or cannot be attributed to a user, is a gap:
 * reported through `gaps()` and left out of the archive.
 */
export class KyselyGroupExporter implements ExporterPort {
  readonly key: string;
  readonly tables: readonly string[];

  constructor(
    descriptor: ExporterDescriptor,
    private readonly db: PrivacyDb,
    private readonly catalog: SchemaCatalog,
    private readonly cipher: FieldDecryptPort,
  ) {
    this.key = descriptor.key;
    this.tables = descriptor.tables;
  }

  async gaps(): Promise<readonly string[]> {
    const schema = await this.catalog.load();
    return this.tables.filter((t) => {
      const cols = schema.tables.get(t);
      return cols === undefined || locatorFor(t, cols) === undefined;
    });
  }

  async collect(userId: string): Promise<ExportSection> {
    if (!isUuid(userId)) throw new Error("export subject must be a uuid");
    const schema = await this.catalog.load();
    const out: Record<string, readonly ExportRow[]> = {};
    await inSystemTx(this.db, true, async (trx) => {
      for (const table of this.tables) {
        const cols = schema.tables.get(table);
        const where = cols === undefined ? undefined : locatorFor(table, cols);
        if (cols === undefined || where === undefined) continue;
        const res = await sql<{ r: JsonRow }>`
          select to_jsonb(t) as r from ${sql.table(table)} as t where ${where(userId)} order by to_jsonb(t)::text`.execute(trx);
        const rows: ExportRow[] = [];
        for (const { r } of res.rows) rows.push(await this.shape(table, cols, r));
        out[table] = rows;
      }
    });
    return { tables: out };
  }

  private async shape(table: string, cols: ReadonlyMap<string, ColumnInfo>, row: JsonRow): Promise<ExportRow> {
    const spec = TABLE_SPECS[table];
    const omit = new Set(spec?.omit ?? []);
    const shaped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(row)) {
      if (omit.has(name)) continue;
      const aad = spec?.decrypt?.[name];
      if (aad !== undefined) {
        const bytes = bytesOf(value);
        shaped[name] = bytes === null ? null : plain(dec.decode(await this.cipher.decrypt(bytes, aad(row))));
        continue;
      }
      if (cols.get(name)?.type === "bytea") continue;
      shaped[name] = value;
    }
    return shaped;
  }
}

/** One exporter per manifest group, all over the same schema catalog. */
export function createKyselyExporters(
  manifest: readonly ExporterDescriptor[],
  db: PrivacyDb,
  cipher: FieldDecryptPort,
): readonly KyselyGroupExporter[] {
  const catalog = new SchemaCatalog(db);
  return manifest.map((d) => new KyselyGroupExporter(d, db, catalog, cipher));
}
