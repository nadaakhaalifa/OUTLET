import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { withoutConcurrently } from './pglite.js';
import { defaultMigrationsDir, loadMigrations, migrate, parseMigration, type MigrationFile } from './runner.js';

/**
 * Migrates ONE PGlite instance once and hands out cheap isolated copies via
 * `clone()` (each test gets a fresh database without re-running migrations).
 * DEVELOPMENT AND TEST ONLY.
 */
export const createTestDatabaseFactory = async (maxVersion?: number): Promise<{
  readonly template: PGlite;
  fresh(): Promise<PGlite>;
  close(): Promise<void>;
}> => {
  const template =
    maxVersion === undefined ? new PGlite() : await createTestDatabaseUpTo(maxVersion);
  if (maxVersion === undefined) await migrate(withoutConcurrently(template), await loadMigrations());
  return {
    template,
    // clone() is typed as the interface but returns a PGlite instance
    fresh: async () => (await template.clone()) as PGlite,
    close: () => template.close(),
  };
};

/**
 * PGlite with migrations 1..`maxVersion` applied. Use this for a persistence
 * adapter test that only needs a known baseline, so another module's
 * in-flight migration (or a numbering gap) cannot break an unrelated suite.
 * Files above `maxVersion` are ignored; files at or below it must be contiguous.
 */
export const createTestDatabaseUpTo = async (maxVersion: number): Promise<PGlite> => {
  const dir = defaultMigrationsDir();
  const names = (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const n of names) {
    const f = parseMigration(n, await readFile(join(dir, n), 'utf8'));
    if (f.version <= maxVersion) files.push(f);
  }
  files.forEach((f, i) => {
    if (f.version !== i + 1) throw new Error(`migration gap below ${maxVersion}: expected ${i + 1}, found ${f.filename}`);
  });
  const db = new PGlite();
  await migrate(withoutConcurrently(db), files);
  return db;
};
