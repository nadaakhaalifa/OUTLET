import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabaseFactory, createTestDatabaseUpTo } from './test-database.js';

describe('createTestDatabaseFactory', async () => {
  const f = await createTestDatabaseFactory(11);
  afterAll(() => f.close());
  it('hands out isolated migrated copies', async () => {
    const a = await f.fresh();
    const b = await f.fresh();
    await a.query(`INSERT INTO users (id) VALUES ('0192f3a4-5b6c-7d8e-9f01-23456789abc1')`);
    expect((await a.query('SELECT 1 FROM users')).rows).toHaveLength(1);
    expect((await b.query('SELECT 1 FROM users')).rows).toHaveLength(0);
    expect((await b.query(`SELECT 1 FROM pg_roles WHERE rolname='app_user'`)).rows).toHaveLength(1);
  });
});

describe('createTestDatabaseUpTo', () => {
  it('applies only the requested prefix', async () => {
    const db = await createTestDatabaseUpTo(4);
    const v = await db.query<{ n: number }>('SELECT max(version)::int AS n FROM schema_migrations');
    expect(v.rows[0]?.n).toBe(4);
    expect((await db.query(`SELECT 1 FROM pg_tables WHERE tablename='outbox_events'`)).rows).toHaveLength(1);
    expect((await db.query(`SELECT 1 FROM pg_tables WHERE tablename='saga_instances'`)).rows).toHaveLength(0);
    await db.close();
  });
});
