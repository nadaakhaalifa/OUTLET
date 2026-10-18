import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validateInventory, checkRequired, checkColumns, CONSENT_PURPOSES } from '../inventory-schema.mjs';
import { extractColumns, extractDroppedColumns } from '../sql-columns.mjs';
import { renderAll } from '../generate-ropa.mjs';
import { runChecks, DEFAULTS } from '../check-inventory.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

function minimal() {
  return {
    inventory_version: 1,
    last_reviewed: '2026-10-10',
    status: 'DRAFT_NOT_REVIEWED_BY_COUNSEL',
    consent_purposes: [...CONSENT_PURPOSES],
    purposes: { p_one: { title: 'One', description: 'First purpose' } },
    processors: {
      cloud: {
        name: 'Cloud',
        category: 'cloud',
        candidates: [],
        role: 'processor',
        location: 'unknown',
        dpa_status: 'unknown',
        sub_processors: 'unknown',
        transfer_tia: 'unknown',
        contract_status: 'not_started',
        spec_ref: 'T7',
        verify: true,
      },
    },
    retention: {
      keep: {
        description: 'Keep',
        period: { value: 1, unit: 'years' },
        trigger: 'collection',
        after: 'delete',
        purge_job: 'purge_keep',
        purge_metric: 'purge_keep_total',
        source: 'spec',
        verify: false,
      },
    },
    tables: [
      {
        name: 'things',
        spec_ref: 'test',
        source: 'derived',
        data_subjects: ['shopper'],
        defaults: {
          purpose: ['p_one'],
          lawful_basis: 'contract',
          retention: 'keep',
          processors: ['cloud'],
          residency: 'approved_region',
          on_erasure: 'delete',
        },
        fields: [
          { name: 'id', pii_class: 'P1', encryption: 'none' },
          { name: 'email', pii_class: 'P2', encryption: 'field_envelope' },
        ],
      },
    ],
  };
}

const clone = (o) => structuredClone(o);

test('minimal inventory is valid', () => {
  const r = validateInventory(minimal());
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.resolved.length, 2);
});

test('field without pii_class fails schema', () => {
  const inv = minimal();
  delete inv.tables[0].fields[0].pii_class;
  const r = validateInventory(inv);
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /pii_class/);
});

test('field without encryption fails schema (never defaulted)', () => {
  const inv = minimal();
  delete inv.tables[0].fields[1].encryption;
  assert.equal(validateInventory(inv).ok, false);
});

test('untagged field: missing retention is reported with its path', () => {
  const inv = minimal();
  delete inv.tables[0].defaults.retention;
  const r = validateInventory(inv);
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes('untagged field things.id: missing retention'));
  assert.ok(r.errors.includes('untagged field things.email: missing retention'));
});

test('field-level tag overrides table default', () => {
  const inv = minimal();
  inv.tables[0].fields[1].retention = 'keep';
  delete inv.tables[0].defaults.retention;
  inv.tables[0].fields[0].retention = 'keep';
  assert.equal(validateInventory(inv).ok, true);
});

test('unknown purpose, retention and processor ids fail', () => {
  const inv = minimal();
  inv.tables[0].defaults.purpose = ['nope'];
  inv.tables[0].defaults.retention = 'nope';
  inv.tables[0].defaults.processors = ['nope'];
  const e = validateInventory(inv).errors.join('\n');
  assert.match(e, /unknown purpose "nope"/);
  assert.match(e, /unknown retention "nope"/);
  assert.match(e, /unknown processor "nope"/);
});

test('unknown keys are rejected (strict schema)', () => {
  const inv = minimal();
  inv.tables[0].fields[0].pii = 'P1';
  assert.equal(validateInventory(inv).ok, false);
});

test('consent basis requires a consent purpose, and vice versa', () => {
  const a = minimal();
  a.tables[0].defaults.lawful_basis = 'consent';
  assert.match(validateInventory(a).errors.join('\n'), /requires consent_purpose/);
  const b = minimal();
  b.tables[0].defaults.consent_purpose = 'analytics';
  assert.match(validateInventory(b).errors.join('\n'), /consent_purpose set but lawful_basis/);
});

test('legitimate interest must be flagged verify', () => {
  const inv = minimal();
  inv.tables[0].defaults.lawful_basis = 'legitimate_interest';
  assert.match(validateInventory(inv).errors.join('\n'), /legitimate_interest/);
  inv.tables[0].defaults.verify = true;
  assert.equal(validateInventory(inv).ok, true);
});

test('P3 rules: encryption, residency, external LLM, seller visibility', () => {
  const inv = minimal();
  inv.tables[0].fields.push({ name: 'dob', pii_class: 'P3', encryption: 'none' });
  assert.match(validateInventory(inv).errors.join('\n'), /things\.dob: P3 must be field-encrypted/);
  inv.tables[0].fields[2] = { name: 'dob', pii_class: 'P3', encryption: 'field_envelope', residency: 'global_ok' };
  assert.match(validateInventory(inv).errors.join('\n'), /P3 may not have residency global_ok/);
  inv.tables[0].fields[2] = { name: 'dob', pii_class: 'P3', encryption: 'field_envelope', external_llm: 'consent_and_licence' };
  assert.match(validateInventory(inv).errors.join('\n'), /external_llm never/);
  inv.tables[0].fields[2] = { name: 'dob', pii_class: 'P3', encryption: 'field_envelope', seller_visibility: 'full' };
  assert.match(validateInventory(inv).errors.join('\n'), /delivery snapshot/);
});

test('P2 may not be global_ok', () => {
  const inv = minimal();
  inv.tables[0].fields[1].residency = 'global_ok';
  assert.match(validateInventory(inv).errors.join('\n'), /P2 may not have residency global_ok/);
});

test('device_only residency needs device-side encryption and vice versa', () => {
  const inv = minimal();
  inv.tables[0].fields[0].residency = 'device_only';
  assert.match(validateInventory(inv).errors.join('\n'), /device_only requires/);
  const inv2 = minimal();
  inv2.tables[0].fields[0].encryption = 'not_persisted';
  assert.match(validateInventory(inv2).errors.join('\n'), /not_persisted requires residency device_only/);
});

test('device_only storage forces device_only residency on every field', () => {
  const inv = minimal();
  inv.tables[0].storage = 'device_only';
  assert.match(validateInventory(inv).errors.join('\n'), /storage is device_only/);
});

test('duplicate tables and fields fail', () => {
  const inv = minimal();
  inv.tables[0].fields.push({ name: 'id', pii_class: 'P1', encryption: 'none' });
  assert.match(validateInventory(inv).errors.join('\n'), /duplicate field things\.id/);
  const inv2 = minimal();
  inv2.tables.push(clone(inv2.tables[0]));
  assert.match(validateInventory(inv2).errors.join('\n'), /duplicate table things/);
});

test('all nine B1 consent purposes must be declared', () => {
  const inv = minimal();
  inv.consent_purposes = inv.consent_purposes.filter((c) => c !== 'cross_border_ml');
  assert.match(validateInventory(inv).errors.join('\n'), /cross_border_ml/);
});

test('budget_insights tables must forbid promotions and ads importers', () => {
  const inv = minimal();
  inv.tables[0].defaults.lawful_basis = 'consent';
  inv.tables[0].defaults.consent_purpose = 'budget_insights';
  assert.match(validateInventory(inv).errors.join('\n'), /forbidden_importers/);
  inv.tables[0].forbidden_importers = ['promotions', 'ads'];
  assert.equal(validateInventory(inv).ok, true);
});

test('signed DPA needs evidence; unknown DPA must be flagged verify', () => {
  const inv = minimal();
  inv.processors.cloud.dpa_status = 'signed';
  assert.match(validateInventory(inv).errors.join('\n'), /dpa_evidence/);
  const inv2 = minimal();
  inv2.processors.cloud.verify = false;
  assert.match(validateInventory(inv2).errors.join('\n'), /unknown DPA status must set verify true/);
});

test('proposed non-null retention period must be flagged verify', () => {
  const inv = minimal();
  inv.retention.keep.source = 'proposed';
  assert.match(validateInventory(inv).errors.join('\n'), /proposed periods/);
});

test('null retention period needs an ending trigger', () => {
  const inv = minimal();
  inv.retention.keep.period = null;
  assert.match(validateInventory(inv).errors.join('\n'), /null period/);
  inv.retention.keep.trigger = 'account_deletion';
  assert.equal(validateInventory(inv).ok, true);
});

test('P2 excluded from DSAR export needs a note', () => {
  const inv = minimal();
  inv.tables[0].fields[1].dsar_export = false;
  assert.match(validateInventory(inv).errors.join('\n'), /DSAR export needs a note/);
});

test('checkRequired: missing and constraint violations', () => {
  const { resolved } = validateInventory(minimal());
  const req = {
    must_exist: ['things.email', 'things.phone'],
    constraints: [{ path: 'things.email', pii_class: 'P3', reason: 'test' }],
  };
  const e = checkRequired(resolved, req).join('\n');
  assert.match(e, /things\.phone is missing/);
  assert.match(e, /things\.email: pii_class is P2 but must be P3/);
  assert.deepEqual(checkRequired(resolved, { must_exist: ['things.id'], constraints: [] }), []);
});

test('checkColumns: untagged column fails, stale is informational', () => {
  const { resolved } = validateInventory(minimal());
  const r = checkColumns(resolved, ['things.id', 'things.new_col']);
  assert.deepEqual(r.errors, ['untagged column things.new_col: add it to data_inventory.yaml']);
  assert.deepEqual(r.stale, ['things.email']);
});

test('extractColumns reads CREATE TABLE and ADD COLUMN, skipping constraints', () => {
  const sql = `
    -- CREATE TABLE ignored (id int);
    CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL CHECK (status IN ('a', 'b,c')),
      CONSTRAINT users_uq UNIQUE (status),
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS public.sessions (
      "id" bigint,
      amount numeric(10, 2)
    );
    ALTER TABLE users ADD COLUMN phone_ct bytea;
  `;
  assert.deepEqual(extractColumns(sql), [
    'sessions.amount',
    'sessions.id',
    'users.id',
    'users.phone_ct',
    'users.status',
  ]);
});

test('extractColumns reads every clause of a multi-column ALTER TABLE', () => {
  const sql = `
    ALTER TABLE jobs
      ADD COLUMN a integer NOT NULL DEFAULT 0 CHECK (a >= 0),
      ADD COLUMN IF NOT EXISTS "b" text CHECK (b IS NULL OR char_length(b) BETWEEN 10 AND 200),
      ADD COLUMN c smallint;
    ALTER TABLE usage ADD COLUMN d integer;
  `;
  assert.deepEqual(extractColumns(sql), ['jobs.a', 'jobs.b', 'jobs.c', 'usage.d']);
});

// ---- the real inventory ----

const realRaw = parse(readFileSync(DEFAULTS.inventory, 'utf8'));

test('real inventory validates with zero errors', () => {
  const r = validateInventory(realRaw);
  assert.deepEqual(r.errors, []);
});

test('real inventory covers every nine consent purposes and every spec-named field', () => {
  const full = runChecks({
    inventoryPath: DEFAULTS.inventory,
    requiredPath: DEFAULTS.required,
    migrationsDir: DEFAULTS.migrations,
  });
  assert.deepEqual(full.errors, []);
  assert.equal(full.ok, true);
  assert.ok(full.stats.fields > 400);
});

test('real inventory: every migration column is tagged (CI gate)', () => {
  const r = runChecks({ inventoryPath: DEFAULTS.inventory, requiredPath: null, migrationsDir: DEFAULTS.migrations });
  assert.deepEqual(r.errors.filter((e) => e.startsWith('untagged column')), []);
});

test('real inventory: dropping a tag makes the check fail', () => {
  const broken = clone(realRaw);
  const users = broken.tables.find((t) => t.name === 'users');
  delete users.defaults.retention;
  const r = validateInventory(broken);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('untagged field users.')));
});

test('real inventory: every processor has DPA status unknown (none invented as signed)', () => {
  for (const [id, p] of Object.entries(realRaw.processors)) {
    assert.equal(p.dpa_status, 'unknown', `${id} must not claim a DPA that does not exist`);
  }
});

test('real inventory: processors register covers required categories', () => {
  const cats = new Set(Object.values(realRaw.processors).map((p) => p.category));
  for (const c of ['psp', 'courier', 'sms', 'whatsapp_bsp', 'llm_vendor', 'cloud']) {
    assert.ok(cats.has(c), `missing processor category ${c}`);
  }
});

test('generator is deterministic and matches the files on disk', () => {
  const r = validateInventory(realRaw);
  const a = renderAll(r.inventory, r.resolved);
  const b = renderAll(r.inventory, r.resolved);
  assert.deepEqual(a, b);
  for (const [name, content] of Object.entries(a)) {
    const onDisk = readFileSync(join(repoRoot, 'docs', 'privacy', name), 'utf8');
    assert.equal(onDisk, `${content}\n`, `${name} is stale, run node tooling/privacy/generate-ropa.mjs`);
  }
});

test('RoPA mentions every table and every purpose in use', () => {
  const r = validateInventory(realRaw);
  const ropa = renderAll(r.inventory, r.resolved)['ropa.md'];
  for (const t of r.inventory.tables) assert.ok(ropa.includes(`### \`${t.name}\``), `ropa missing ${t.name}`);
  const used = new Set(r.resolved.flatMap((f) => f.purpose ?? []));
  for (const p of used) assert.ok(ropa.includes(`(\`${p}\`)`), `ropa missing purpose ${p}`);
});

test('extractDroppedColumns reads DROP COLUMN clauses and ignores comments', () => {
  assert.deepEqual(
    extractDroppedColumns('-- ALTER TABLE x DROP COLUMN no;\nALTER TABLE t DROP COLUMN user_id, ADD COLUMN account_id uuid;'),
    ['t.user_id'],
  );
});
