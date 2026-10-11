import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Minimal surface of PGlite used by the runner (keeps this file driver-agnostic). */
export interface SqlExecutor {
  exec(sql: string): Promise<unknown>;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export class MigrationError extends Error {
  public override readonly name = 'MigrationError';
  public constructor(
    public readonly code: 'checksum_mismatch' | 'bad_filename' | 'sequence_gap' | 'failed' | 'missing_applied',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export interface MigrationFile {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
  /** `-- no-transaction` header: statements run one by one (needed for CONCURRENTLY). */
  readonly transactional: boolean;
}

export const defaultMigrationsDir = (): string =>
  fileURLToPath(new URL('../migrations', import.meta.url));

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export const checksumOf = (sql: string): string => createHash('sha256').update(sql, 'utf8').digest('hex');

export const parseMigration = (filename: string, sql: string): MigrationFile => {
  const m = FILE_RE.exec(filename);
  if (!m || m[1] === undefined || m[2] === undefined) {
    throw new MigrationError('bad_filename', `migration file name must match NNNN_snake_case.sql: ${filename}`);
  }
  return {
    version: Number(m[1]),
    name: m[2],
    filename,
    sql,
    checksum: checksumOf(sql),
    transactional: !/^--\s*no-transaction\s*$/m.test(sql),
  };
};

export const loadMigrations = async (dir: string = defaultMigrationsDir()): Promise<MigrationFile[]> => {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const n of names) files.push(parseMigration(n, await readFile(join(dir, n), 'utf8')));
  files.forEach((f, i) => {
    if (f.version !== i + 1) {
      throw new MigrationError('sequence_gap', `expected migration ${String(i + 1).padStart(4, '0')} but found ${f.filename}`);
    }
  });
  return files;
};

const LEDGER = `CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

export interface MigrateResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
}

/** Applies pending migrations in order. Applied files are checksum-verified, never re-run. */
export const migrate = async (db: SqlExecutor, files: readonly MigrationFile[]): Promise<MigrateResult> => {
  await db.exec(LEDGER);
  const { rows } = await db.query<{ version: number; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  const done = new Map(rows.map((r) => [Number(r.version), r.checksum]));
  const known = new Set(files.map((f) => f.version));
  for (const v of done.keys()) {
    if (!known.has(v)) throw new MigrationError('missing_applied', `applied migration ${v} has no file`);
  }
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const prior = done.get(f.version);
    if (prior !== undefined) {
      if (prior !== f.checksum) {
        throw new MigrationError('checksum_mismatch', `${f.filename} was modified after it was applied`);
      }
      skipped.push(f.filename);
      continue;
    }
    try {
      if (f.transactional) {
        await db.exec('BEGIN');
        try {
          await db.exec(f.sql);
          await record(db, f);
          await db.exec('COMMIT');
        } catch (e) {
          await db.exec('ROLLBACK');
          throw e;
        }
      } else {
        for (const stmt of splitStatements(f.sql)) await db.exec(stmt);
        await record(db, f);
      }
    } catch (cause) {
      throw new MigrationError('failed', `${f.filename} failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
    applied.push(f.filename);
  }
  return { applied, skipped };
};

const record = async (db: SqlExecutor, f: MigrationFile): Promise<void> => {
  await db.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
    f.version,
    f.name,
    f.checksum,
  ]);
};

/** Splits SQL on top-level semicolons, keeping text verbatim (honours quotes, comments, dollar quotes). */
export const splitStatements = (sql: string): string[] => {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const flush = (end: number): void => {
    const piece = sql.slice(start, end).trim();
    // a piece holding only comments is not a statement
    if (piece.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0) out.push(piece);
    start = end + 1;
  };
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const e = sql.indexOf('\n', i);
      i = e === -1 ? sql.length : e;
    } else if (c === '/' && sql[i + 1] === '*') {
      const e = sql.indexOf('*/', i + 2);
      i = e === -1 ? sql.length : e + 2;
    } else if (c === "'") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === "'" && sql[j + 1] !== "'")) j += sql[j] === "'" ? 2 : 1;
      i = j + 1;
    } else if (c === '$') {
      const m = /^\$([A-Za-z_]*)\$/.exec(sql.slice(i));
      if (m) {
        const e = sql.indexOf(m[0], i + m[0].length);
        i = e === -1 ? sql.length : e + m[0].length;
      } else i += 1;
    } else if (c === ';') {
      flush(i);
      i += 1;
    } else i += 1;
  }
  flush(sql.length);
  return out;
};
