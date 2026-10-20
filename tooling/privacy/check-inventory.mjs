#!/usr/bin/env node
// Validate docs/privacy/data_inventory.yaml (spec B1, T6). Exits 1 on any untagged field,
// schema violation, broken cross-reference, missing spec-named field, or SQL column that has no tag.
//
// Usage: node tooling/privacy/check-inventory.mjs [--inventory <file>] [--required <file>]
//                                                  [--migrations <dir>] [--no-migrations] [--json]
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { validateInventory, checkRequired, checkColumns } from './inventory-schema.mjs';
import { extractColumns, extractDroppedColumns } from './sql-columns.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const DEFAULTS = {
  inventory: join(repoRoot, 'docs', 'privacy', 'data_inventory.yaml'),
  required: join(here, 'required-fields.json'),
  migrations: join(repoRoot, 'packages', 'db', 'migrations'),
};

/** Tables that exist in migrations but hold no personal data and are tagged P1 in bulk elsewhere. */
function readMigrationColumns(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const cols = new Set();
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    for (const c of extractColumns(sql)) cols.add(c);
    for (const c of extractDroppedColumns(sql)) cols.delete(c);
  }
  return [...cols].sort();
}

/**
 * Run every check. Pure with respect to its arguments: reads only the given paths.
 * @returns {{ok: boolean, errors: string[], warnings: string[], stats: object}}
 */
export function runChecks({ inventoryPath, requiredPath, migrationsDir }) {
  const errors = [];
  const warnings = [];
  let raw;
  try {
    raw = parse(readFileSync(inventoryPath, 'utf8'));
  } catch (e) {
    return { ok: false, errors: [`cannot read inventory ${inventoryPath}: ${e.message}`], warnings, stats: {} };
  }
  const result = validateInventory(raw);
  errors.push(...result.errors);
  warnings.push(...result.warnings);
  if (!result.inventory) return { ok: false, errors, warnings, stats: {} };

  if (requiredPath) {
    try {
      errors.push(...checkRequired(result.resolved, JSON.parse(readFileSync(requiredPath, 'utf8'))));
    } catch (e) {
      errors.push(`cannot read required-fields ${requiredPath}: ${e.message}`);
    }
  }

  let columnsChecked = 0;
  if (migrationsDir) {
    if (existsSync(migrationsDir)) {
      const cols = readMigrationColumns(migrationsDir);
      columnsChecked = cols.length;
      const { errors: colErrors, stale } = checkColumns(result.resolved, cols);
      errors.push(...colErrors);
      // Spec-named fields not yet migrated are expected during early phases, so only a count is reported.
      warnings.push(`${stale.length} inventory fields have no migration column yet (expected before their phase)`);
    } else {
      warnings.push(`migrations directory ${migrationsDir} not found, column check skipped`);
    }
  }

  const byClass = {};
  for (const r of result.resolved) byClass[r.pii_class] = (byClass[r.pii_class] ?? 0) + 1;
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      tables: result.inventory.tables.length,
      fields: result.resolved.length,
      by_class: byClass,
      processors: Object.keys(result.inventory.processors).length,
      retention_rules: Object.keys(result.inventory.retention).length,
      migration_columns_checked: columnsChecked,
    },
  };
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--inventory') opts.inventory = resolve(argv[++i]);
    else if (a === '--required') opts.required = resolve(argv[++i]);
    else if (a === '--migrations') opts.migrations = resolve(argv[++i]);
    else if (a === '--no-migrations') opts.migrations = null;
    else if (a === '--json') opts.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  const out = runChecks({
    inventoryPath: opts.inventory,
    requiredPath: opts.required,
    migrationsDir: opts.migrations,
  });
  if (opts.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const w of out.warnings) console.warn(`warning: ${w}`);
    for (const e of out.errors) console.error(`error: ${e}`);
    console.log(
      `${out.ok ? 'PASS' : 'FAIL'}: ${out.stats.tables ?? 0} tables, ${out.stats.fields ?? 0} fields, ` +
        `${out.errors.length} errors, ${out.warnings.length} warnings`,
    );
  }
  process.exit(out.ok ? 0 : 1);
}
