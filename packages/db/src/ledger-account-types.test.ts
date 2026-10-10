import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_TYPES } from '../../domain/src/index';
import { lintMigration } from './lint';
import { toPersistedOwnerType } from './ledger-owner';
import { createTestDatabase } from './pglite';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const migrationPath = join(repoRoot, 'packages/db/migrations/0011_ledger_account_types.sql');
const sql = readFileSync(migrationPath, 'utf8');

interface SeedRow {
  code: string;
  category: string;
  normal_side: string;
  owner_type: string;
  in_spec_t4: boolean;
  status: string;
}

const parseSeed = (text: string): SeedRow[] =>
  [...text.matchAll(/^\s+\('([a-z_]+)', '(\w+)', '(\w+)', '(\w+)', (true|false), '(\w+)'\),?$/gm)].map((m) => ({
    code: m[1] ?? '',
    category: m[2] ?? '',
    normal_side: m[3] ?? '',
    owner_type: m[4] ?? '',
    in_spec_t4: m[5] === 'true',
    status: m[6] ?? '',
  }));

describe('ledger_account_types seed vs domain ACCOUNT_TYPES', () => {
  it('has exactly the domain account types, with matching attributes', () => {
    const expected = Object.values(ACCOUNT_TYPES)
      .map((t): SeedRow => ({
        code: t.type,
        category: t.category,
        normal_side: t.normalBalance,
        owner_type: toPersistedOwnerType(t.owner),
        in_spec_t4: t.inSpecT4,
        status: t.status,
      }))
      .sort((a, b) => a.code.localeCompare(b.code));
    const actual = parseSeed(sql).sort((a, b) => a.code.localeCompare(b.code));
    expect(actual.length).toBeGreaterThan(0);
    expect(actual).toEqual(expected);
  });

  it('is byte-identical to the generator output', async () => {
    const gen = (await import(pathToFileURL(join(repoRoot, 'tooling/db/generate-account-types-migration.mjs')).href)) as {
      parseAccountTypes: (src: string) => unknown[];
      render: (rows: unknown[]) => string;
    };
    const src = readFileSync(join(repoRoot, 'packages/domain/src/chart-of-accounts/accounts.ts'), 'utf8');
    expect(gen.render(gen.parseAccountTypes(src))).toBe(sql);
  });

  it('passes the migration linter', () => {
    expect(lintMigration(sql)).toEqual([]);
  });
});

describe('ledger_accounts.type foreign key', () => {
  let db: PGlite;
  beforeAll(async () => {
    ({ db } = await createTestDatabase());
  }, 60_000);
  afterAll(async () => {
    await db.close();
  });

  it('seeds one row per domain type', async () => {
    const r = await db.query<{ code: string }>('SELECT code FROM ledger_account_types ORDER BY code');
    expect(r.rows.map((x) => x.code)).toEqual(Object.keys(ACCOUNT_TYPES).sort());
  });

  it('accepts a known type and rejects a typo', async () => {
    await db.query(`INSERT INTO ledger_accounts (type, owner_type, currency) VALUES ('platform_commission','platform','EGP')`);
    await expect(
      db.query(`INSERT INTO ledger_accounts (type, owner_type, currency) VALUES ('platform_comission','platform','EGP')`),
    ).rejects.toThrow(/foreign key|violates/);
  });

  it('the constraint is validated', async () => {
    const r = await db.query<{ convalidated: boolean }>(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'ledger_accounts_type_fk'`,
    );
    expect(r.rows[0]?.convalidated).toBe(true);
  });

  it('every persisted owner_type in the seed is allowed by ledger_accounts', async () => {
    for (const t of parseSeed(sql)) {
      const owner = t.owner_type === 'platform' ? '' : 'x';
      await db.query(
        `INSERT INTO ledger_accounts (type, owner_type, owner_id, sub_key, currency) VALUES ($1,$2,$3,'seedcheck','EGP')`,
        [t.code, t.owner_type, owner],
      );
    }
  });
});
