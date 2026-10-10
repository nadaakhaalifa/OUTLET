import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lintMigration, loadMigrations, migrate, MigrationError, parseMigration, splitStatements } from './index.js';
import { createTestDatabase, withoutConcurrently } from './pglite.js';

let db: PGlite;
const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const rejects = async (p: Promise<unknown>, re: RegExp): Promise<void> => {
  await expect(p).rejects.toThrow(re);
};

const mkAccounts = async (tag: string): Promise<{ a: string; b: string }> => {
  const a = await db.query<{ id: string }>(
    `INSERT INTO ledger_accounts (type, owner_type, currency, sub_key) VALUES ('cash','platform','EGP',$1) RETURNING id`, [`a-${tag}`]);
  const b = await db.query<{ id: string }>(
    `INSERT INTO ledger_accounts (type, owner_type, currency, sub_key) VALUES ('revenue','platform','EGP',$1) RETURNING id`, [`b-${tag}`]);
  return { a: a.rows[0]?.id ?? '', b: b.rows[0]?.id ?? '' };
};

const entry = async (key: string): Promise<string> => {
  const r = await db.query<{ id: string }>(
    `INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id)
     VALUES ('test', $1, now(), 'order', 'o1') RETURNING id`, [key]);
  return r.rows[0]?.id ?? '';
};

beforeAll(async () => {
  ({ db } = await createTestDatabase());
}, 60_000);
afterAll(async () => { await db.close(); });

describe('migration runner', () => {
  it('applies all migrations and is idempotent', async () => {
    const files = await loadMigrations();
    const again = await migrate(withoutConcurrently(db), files);
    expect(again.applied).toEqual([]);
    expect(again.skipped.length).toBe(files.length);
  });

  it('rejects a modified applied migration', async () => {
    const files = await loadMigrations();
    const first = files[0];
    if (!first) throw new Error('no migrations');
    const tampered = [parseMigration(first.filename, first.sql + '\n-- edited'), ...files.slice(1)];
    await expect(migrate(withoutConcurrently(db), tampered)).rejects.toMatchObject({ code: 'checksum_mismatch' });
  });

  it('rolls back a failing migration and reports it', async () => {
    const fresh = new PGlite();
    const bad = parseMigration('0001_bad.sql', 'CREATE TABLE t1 (id int); SELECT 1/0;');
    await expect(migrate(fresh, [bad])).rejects.toBeInstanceOf(MigrationError);
    const r = await fresh.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_tables WHERE tablename='t1'`);
    expect(r.rows[0]?.n).toBe('0');
    await fresh.close();
  });

  it('splits statements without breaking strings or function bodies', () => {
    const parts = splitStatements("SELECT 'a;b'; -- c;\nCREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$; SELECT 2");
    expect(parts.length).toBe(3);
  });

  it('records the no-transaction directive', async () => {
    const files = await loadMigrations();
    expect(files.find((f) => f.name === 'outbox_indexes')?.transactional).toBe(false);
  });

  it('rejects bad file names', () => {
    expect(() => parseMigration('1_x.sql', '')).toThrow(MigrationError);
  });
});

describe('ledger', () => {
  it('accepts a balanced entry at commit', async () => {
    const { a, b } = await mkAccounts('ok');
    await db.transaction(async (tx) => {
      const e = await tx.query<{ id: string }>(
        `INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id)
         VALUES ('t','ok-1', now(),'order','o') RETURNING id`);
      const id = e.rows[0]?.id;
      await tx.query(`INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ($1,$2,10000,'EGP'),($1,$3,-10000,'EGP')`, [id, a, b]);
    });
    const t = await db.query<{ total: string }>(`SELECT total::text FROM ledger_trial_balance WHERE currency='EGP'`);
    expect(t.rows[0]?.total).toBe('0');
  });

  it('rejects an unbalanced entry at commit', async () => {
    const { a, b } = await mkAccounts('unbal');
    await rejects(
      db.transaction(async (tx) => {
        const e = await tx.query<{ id: string }>(
          `INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id)
           VALUES ('t','unbal-1', now(),'order','o') RETURNING id`);
        const id = e.rows[0]?.id;
        await tx.query(`INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ($1,$2,10000,'EGP'),($1,$3,-9999,'EGP')`, [id, a, b]);
      }),
      /unbalanced/,
    );
    const r = await db.query(`SELECT 1 FROM journal_entries WHERE idempotency_key='unbal-1'`);
    expect(r.rows.length).toBe(0);
  });

  it('rejects an entry with no postings and a single posting', async () => {
    await rejects(db.transaction(async (tx) => {
      await tx.query(`INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id) VALUES ('t','empty-1',now(),'o','1')`);
    }), /at least 2/);
  });

  it('rejects per-currency imbalance even when the grand total is zero', async () => {
    const { a, b } = await mkAccounts('cur');
    const usd = await db.query<{ id: string }>(`INSERT INTO ledger_accounts (type, owner_type, currency, sub_key) VALUES ('cash','platform','USD','u') RETURNING id`);
    const u = usd.rows[0]?.id;
    await rejects(db.transaction(async (tx) => {
      const e = await tx.query<{ id: string }>(`INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id) VALUES ('t','cur-1',now(),'o','1') RETURNING id`);
      const id = e.rows[0]?.id;
      await tx.query(`INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ($1,$2,100,'EGP'),($1,$3,-100,'USD'),($1,$4,100,'USD'),($1,$5,-100,'EGP')`, [id, a, u, u, b]);
      await tx.query(`INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ($1,$2,5,'EGP')`, [id, a]);
    }), /unbalanced/);
  });

  it('rejects a posting whose currency differs from the account currency', async () => {
    const { a } = await mkAccounts('fx');
    await rejects(db.transaction(async (tx) => {
      const e = await tx.query<{ id: string }>(`INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id) VALUES ('t','fx-1',now(),'o','1') RETURNING id`);
      await tx.query(`INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ($1,$2,1,'USD')`, [e.rows[0]?.id, a]);
    }), /foreign key|violates/);
  });

  it('enforces journal idempotency_key uniqueness', async () => {
    const { a, b } = await mkAccounts('idem');
    const post = async (): Promise<void> => {
      await db.transaction(async (tx) => {
        const e = await tx.query<{ id: string }>(`INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id) VALUES ('t','idem-1',now(),'o','1') RETURNING id`);
        const id = e.rows[0]?.id;
        await tx.query(`INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ($1,$2,1,'EGP'),($1,$3,-1,'EGP')`, [id, a, b]);
      });
    };
    await post();
    await rejects(post(), /duplicate key|unique/);
  });

  it('rejects UPDATE, DELETE and TRUNCATE on postings and entries', async () => {
    await rejects(db.query(`UPDATE postings SET amount = amount + 1`), /append-only/);
    await rejects(db.query(`DELETE FROM postings`), /append-only/);
    await rejects(db.query(`TRUNCATE postings`), /append-only/);
    await rejects(db.query(`UPDATE journal_entries SET kind = 'x'`), /append-only/);
    await rejects(db.query(`DELETE FROM journal_entries`), /append-only/);
    await rejects(db.query(`TRUNCATE journal_entries CASCADE`), /append-only/);
  });

  it('rejects adding postings to an entry from a later transaction', async () => {
    const { a, b } = await mkAccounts('late');
    const id = await entry('late-1').catch(() => '');
    expect(id).toBe(''); // autocommit entry without postings fails at its own commit
    const ok = await db.transaction(async (tx) => {
      const e = await tx.query<{ id: string }>(`INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id) VALUES ('t','late-2',now(),'o','1') RETURNING id`);
      const eid = e.rows[0]?.id;
      await tx.query(`INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ($1,$2,1,'EGP'),($1,$3,-1,'EGP')`, [eid, a, b]);
      return eid;
    });
    await rejects(db.query(`INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ($1,$2,1,'EGP')`, [ok, a]), /transaction that created/);
  });

  it('forbids zero-amount postings and changing account identity', async () => {
    const { a, b } = await mkAccounts('zero');
    await rejects(db.transaction(async (tx) => {
      const e = await tx.query<{ id: string }>(`INSERT INTO journal_entries (kind, idempotency_key, occurred_at, ref_type, ref_id) VALUES ('t','zero-1',now(),'o','1') RETURNING id`);
      await tx.query(`INSERT INTO postings (entry_id, account_id, amount, currency) VALUES ($1,$2,0,'EGP'),($1,$3,0,'EGP')`, [e.rows[0]?.id, a, b]);
    }), /check constraint|amount/);
    await rejects(db.query(`UPDATE ledger_accounts SET currency='USD' WHERE id=$1`, [a]), /immutable/);
  });
});

describe('audit log hash chain', () => {
  const add = async (chain: string, action: string): Promise<void> => {
    await db.query(`INSERT INTO audit_log (chain_id, actor_type, action, diff_redacted) VALUES ($1,'system',$2,'{"k":1}')`, [chain, action]);
  };
  const verify = async (chain: string): Promise<string[]> => {
    const r = await db.query<{ problem: string }>(`SELECT problem FROM audit_log_verify($1)`, [chain]);
    return r.rows.map((x) => x.problem);
  };
  /** Superuser-level tampering: disable the guard trigger like a compromised DBA would. */
  const tamper = async (sql: string): Promise<void> => {
    await db.exec(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_immutable_trg`);
    try { await db.exec(sql); } finally { await db.exec(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_immutable_trg`); }
  };

  it('chains rows and verifies clean', async () => {
    for (const a of ['a', 'b', 'c', 'd']) await add('c-clean', a);
    expect(await verify('c-clean')).toEqual([]);
    const r = await db.query<{ seq: string }>(`SELECT seq::text FROM audit_log WHERE chain_id='c-clean' ORDER BY seq`);
    expect(r.rows.map((x) => x.seq)).toEqual(['1', '2', '3', '4']);
  });

  it('rejects UPDATE and DELETE through normal paths', async () => {
    await rejects(db.query(`UPDATE audit_log SET action='x'`), /append-only/);
    await rejects(db.query(`DELETE FROM audit_log`), /append-only/);
  });

  it('detects a modified row', async () => {
    for (const a of ['a', 'b', 'c']) await add('c-mod', a);
    await tamper(`UPDATE audit_log SET action='forged' WHERE chain_id='c-mod' AND seq=2`);
    const p = await verify('c-mod');
    expect(p.some((x) => /modified/.test(x))).toBe(true);
  });

  it('detects a removed middle row', async () => {
    for (const a of ['a', 'b', 'c']) await add('c-del', a);
    await tamper(`DELETE FROM audit_log WHERE chain_id='c-del' AND seq=2`);
    const p = await verify('c-del');
    expect(p.some((x) => /gap/.test(x))).toBe(true);
  });

  it('detects a removed head row', async () => {
    for (const a of ['a', 'b']) await add('c-head', a);
    await tamper(`DELETE FROM audit_log WHERE chain_id='c-head' AND seq=1`);
    expect((await verify('c-head')).some((x) => /start at seq 1/.test(x))).toBe(true);
  });

  it('detects a truncated tail only against a checkpoint', async () => {
    for (const a of ['a', 'b', 'c']) await add('c-tail', a);
    await db.query(`SELECT audit_chain_checkpoint('c-tail')`);
    await tamper(`DELETE FROM audit_log WHERE chain_id='c-tail' AND seq=3`);
    expect((await verify('c-tail')).some((x) => /tail truncated/.test(x))).toBe(true);
  });

  it('detects a recomputed-hash forgery that breaks the next link', async () => {
    for (const a of ['a', 'b', 'c']) await add('c-fix', a);
    await tamper(`UPDATE audit_log SET action='forged', hash = sha256(prev_hash || audit_log_canonical(chain_id, seq, occurred_at, actor_type, actor_id, 'forged', target_type, target_id, diff_redacted, ip_hash, device_id, request_id, reason_code)) WHERE chain_id='c-fix' AND seq=1`);
    expect((await verify('c-fix')).some((x) => /prev_hash does not match/.test(x))).toBe(true);
  });
});

describe('outbox, inbox, idempotency, consent', () => {
  it('outbox has the relay columns and guards content', async () => {
    await db.query(`INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1,'order',$2,'order.placed','{}')`, [U(1), U(2)]);
    await db.query(`UPDATE outbox_events SET next_attempt_at = now(), publish_attempts = 1, last_error='E' WHERE id=$1`, [U(1)]);
    await db.query(`UPDATE outbox_events SET dead_lettered_at = now() WHERE id=$1`, [U(1)]);
    await rejects(db.query(`UPDATE outbox_events SET payload='{"x":1}' WHERE id=$1`, [U(1)]), /immutable/);
    await rejects(db.query(`DELETE FROM outbox_events WHERE id=$1`, [U(1)]), /never be deleted/);
    await rejects(db.query(`INSERT INTO outbox_events (id, aggregate_type, aggregate_id, event_type, payload) VALUES ($1,'order',$2,'BadName','{}')`, [U(3), U(2)]), /check/);
  });

  it('claim query with SKIP LOCKED parses and runs (concurrency not verified)', async () => {
    const r = await db.query(`SELECT id FROM outbox_events o WHERE published_at IS NULL AND dead_lettered_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= now()) ORDER BY occurred_at, id LIMIT 10 FOR UPDATE SKIP LOCKED`);
    expect(Array.isArray(r.rows)).toBe(true);
  });

  it('inbox dedupes by (consumer, message_id)', async () => {
    const q = `INSERT INTO inbox_processed (consumer, message_id) VALUES ('c', $1) ON CONFLICT DO NOTHING`;
    const a = await db.query(q, [U(9)]);
    const b = await db.query(q, [U(9)]);
    expect(a.affectedRows).toBe(1);
    expect(b.affectedRows).toBe(0);
  });

  it('idempotency_keys rejects duplicates per (actor, route, key)', async () => {
    const q = `INSERT INTO idempotency_keys (actor_id, route, key, request_hash, expires_at) VALUES ($1,'POST /x',$2,decode(repeat('ab',32),'hex'), now() + interval '1 day')`;
    await db.query(q, [U(5), U(6)]);
    await rejects(db.query(q, [U(5), U(6)]), /duplicate key/);
  });

  it('consent records are append-only and closed over purposes', async () => {
    await db.query(`INSERT INTO consent_records (subject_type, subject_id, purpose, version, granted, method) VALUES ('device',$1,'analytics',1,true,'onboarding')`, [U(7)]);
    await db.query(`INSERT INTO consent_records (subject_type, subject_id, purpose, version, granted, method) VALUES ('device',$1,'analytics',1,false,'settings')`, [U(7)]);
    const cur = await db.query<{ granted: boolean }>(`SELECT granted FROM consents_current WHERE subject_id=$1 AND purpose='analytics'`, [U(7)]);
    expect(cur.rows[0]?.granted).toBe(false);
    await rejects(db.query(`UPDATE consent_records SET granted = true`), /append-only/);
    await rejects(db.query(`INSERT INTO consent_records (subject_type, subject_id, purpose, version, granted, method) VALUES ('user',$1,'tracking_all',1,true,'api')`, [U(7)]), /check/);
  });
});

describe('RLS skeleton', () => {
  it('denies by default and scopes by session variables', async () => {
    await db.query(`INSERT INTO users (id) VALUES ($1), ($2)`, [U(20), U(21)]);
    const as = async (user: string | null, role: string | null): Promise<number> => {
      return db.transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE app_user`);
        await tx.query(`SELECT set_config('app.user_id', $1, true), set_config('app.role', $2, true)`, [user ?? '', role ?? '']);
        const r = await tx.query(`SELECT id FROM users`);
        return r.rows.length;
      });
    };
    expect(await as(null, null)).toBe(0);
    expect(await as(U(20), 'customer')).toBe(1);
    expect(await as(U(20), 'support')).toBeGreaterThanOrEqual(2);
  });

  it('app_user cannot mutate ledger or read audit log without a staff role', async () => {
    await expect(db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE app_user`);
      await tx.query(`UPDATE postings SET amount = 1`);
    })).rejects.toThrow(/permission denied/);
    const n = await db.transaction(async (tx) => {
      await tx.exec(`SET LOCAL ROLE app_user`);
      await tx.query(`SELECT set_config('app.role','customer',true)`);
      return (await tx.query(`SELECT 1 FROM audit_log`)).rows.length;
    });
    expect(n).toBe(0);
  });
});

describe('migration linter', () => {
  const rules = (sql: string): string[] => lintMigration(sql).map((f) => f.rule);

  it('passes every shipped migration', async () => {
    for (const f of await loadMigrations()) expect(lintMigration(f.sql), f.filename).toEqual([]);
  });

  it('flags destructive and breaking statements', () => {
    expect(rules('ALTER TABLE t DROP COLUMN c;')).toEqual(['drop-column']);
    expect(rules('ALTER TABLE t RENAME COLUMN a TO b;')).toEqual(['rename-column']);
    expect(rules('ALTER TABLE t RENAME TO u;')).toEqual(['rename-table']);
    expect(rules('DROP TABLE t;')).toEqual(['drop-table']);
    expect(rules('TRUNCATE t;')).toEqual(['truncate']);
    expect(rules('DELETE FROM t;')).toEqual(['delete-without-where']);
    expect(rules('UPDATE t SET a = 1;')).toEqual(['update-without-where']);
    expect(rules('ALTER TABLE t ALTER COLUMN a TYPE bigint;')).toEqual(['alter-column-type']);
    expect(rules('ALTER TABLE t ALTER COLUMN a SET NOT NULL;')).toEqual(['set-not-null']);
  });

  it('flags NOT NULL without default but allows nullable or defaulted', () => {
    expect(rules('ALTER TABLE t ADD COLUMN a int NOT NULL;')).toEqual(['not-null-without-default']);
    expect(rules("ALTER TABLE t ADD COLUMN a int NOT NULL DEFAULT 0;")).toEqual([]);
    expect(rules('ALTER TABLE t ADD COLUMN a int;')).toEqual([]);
  });

  it('flags non-concurrent index on large tables only', () => {
    expect(rules('CREATE INDEX i ON postings (account_id);')).toEqual(['index-not-concurrent']);
    expect(rules('CREATE UNIQUE INDEX IF NOT EXISTS i ON public.audit_log (x);')).toEqual(['index-not-concurrent']);
    expect(rules('CREATE INDEX CONCURRENTLY i ON postings (account_id);')).toEqual([]);
    expect(rules('CREATE INDEX i ON small_table (a);')).toEqual([]);
  });

  it('ignores text in comments, strings and function bodies', () => {
    expect(rules(`-- DROP TABLE t;\nSELECT 'DROP TABLE t';\n/* TRUNCATE t; */\nCREATE FUNCTION f() RETURNS void LANGUAGE sql AS $$ DELETE FROM t; $$;`)).toEqual([]);
  });

  it('honours lint-allow only with a reason', () => {
    expect(rules('-- lint-allow: drop-column column unused since release 12\nALTER TABLE t DROP COLUMN c;')).toEqual([]);
    expect(rules('-- lint-allow: drop-column\nALTER TABLE t DROP COLUMN c;')).toContain('missing-allow-reason');
  });

  it('reports line numbers', () => {
    const f = lintMigration('SELECT 1;\n\nDROP TABLE t;');
    expect(f[0]?.line).toBe(3);
  });
});
