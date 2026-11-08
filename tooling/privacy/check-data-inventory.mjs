#!/usr/bin/env node
// Fails when a column created by a migration in packages/db/migrations has no row in data_inventory.yaml.
// Usage: node tooling/privacy/check-data-inventory.mjs [--json] [--migrations <dir>] [--inventory <file>]
// Exit codes: 0 = every migration column is tagged; 1 = at least one column is missing; 2 = usage or read error.
// Columns tagged pii_class TODO are reported as "unclassified" but do not fail the check.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TABLE_CONSTRAINT_WORDS = /^(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i;

const stripSqlComments = (sql) => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

const unquote = (ident) => ident.trim().replace(/^"(.*)"$/, "$1");

/** Splits a string on commas that are not nested inside parentheses or quotes. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let current = "";
  for (const ch of body) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

/** Returns the text between the parenthesis that opens at `openIndex` and its matching close. */
function balancedBody(sql, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < sql.length; i += 1) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(openIndex + 1, i);
    }
  }
  throw new Error(`unbalanced parenthesis at offset ${openIndex}`);
}

/**
 * Parses one migration file. Returns [{ table, columns: string[] }] for every CREATE TABLE
 * and the columns added by ALTER TABLE ... ADD COLUMN. Constraints, indexes and policies are ignored.
 */
export function parseMigrationSql(sqlText) {
  const sql = stripSqlComments(sqlText);
  const result = [];
  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[A-Za-z_][\w$]*"?)\s*\(/gi;
  let match;
  while ((match = createRe.exec(sql)) !== null) {
    const table = unquote(match[1]);
    const openIndex = match.index + match[0].length - 1;
    const columns = [];
    for (const item of splitTopLevel(balancedBody(sql, openIndex))) {
      if (TABLE_CONSTRAINT_WORDS.test(item)) continue;
      const ident = /^("[^"]+"|[A-Za-z_][\w$]*)/.exec(item);
      if (ident) columns.push(unquote(ident[1]));
    }
    result.push({ table, columns });
  }
  const alterRe = /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?("?[A-Za-z_][\w$]*"?)\s+ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[A-Za-z_][\w$]*)/gi;
  while ((match = alterRe.exec(sql)) !== null) {
    const table = unquote(match[1]);
    const column = unquote(match[2]);
    if (TABLE_CONSTRAINT_WORDS.test(column)) continue;
    result.push({ table, columns: [column] });
  }
  return result;
}

/** Reads every *.sql file in the migrations directory, in filename order. */
export function parseMigrationDir(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const tables = [];
  for (const file of files) {
    for (const entry of parseMigrationSql(readFileSync(join(dir, file), "utf8"))) {
      tables.push({ ...entry, file });
    }
  }
  return tables;
}

/**
 * Reads the `tables:` section of data_inventory.yaml. Column rows are one-line flow mappings
 * (`      - {name: "id", ..., pii_class: P0, ...}`), so a line scan is enough and needs no YAML dependency.
 * Returns Map<table, Map<column, pii_class>>.
 */
export function parseInventory(yamlText) {
  const map = new Map();
  let inTables = false;
  let currentTable = null;
  for (const line of yamlText.split("\n")) {
    if (/^tables:\s*$/.test(line)) {
      inTables = true;
      continue;
    }
    if (!inTables) continue;
    const tableMatch = /^ {2}- name:\s*"?([^"\s]+)"?\s*$/.exec(line);
    if (tableMatch) {
      currentTable = tableMatch[1];
      if (!map.has(currentTable)) map.set(currentTable, new Map());
      continue;
    }
    const colMatch = /^\s+- \{\s*name:\s*"?([^",}\s]+)"?/.exec(line);
    if (colMatch && currentTable) {
      const pii = /pii_class:\s*"?([A-Za-z0-9]+)"?/.exec(line);
      map.get(currentTable).set(colMatch[1], pii ? pii[1] : "MISSING_PII_CLASS");
    }
  }
  return map;
}

/**
 * Compares migration columns with the inventory.
 * Returns { checked, missing: [{table, column, file}], unclassified: [{table, column}], duplicates: [] }.
 */
export function checkInventory(migrationTables, inventory) {
  const missing = [];
  const unclassified = [];
  let checked = 0;
  for (const { table, columns, file } of migrationTables) {
    const tagged = inventory.get(table);
    for (const column of columns) {
      checked += 1;
      if (!tagged || !tagged.has(column)) {
        missing.push({ table, column, file });
        continue;
      }
      const pii = tagged.get(column);
      if (pii === "TODO" || pii === "MISSING_PII_CLASS") unclassified.push({ table, column });
    }
  }
  return { checked, missing, unclassified };
}

function argValue(args, flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1) return fallback;
  const value = args[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value;
}

export function main(argv, root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")) {
  const json = argv.includes("--json");
  const migrationsDir = resolve(root, argValue(argv, "--migrations", "packages/db/migrations"));
  const inventoryFile = resolve(root, argValue(argv, "--inventory", "data_inventory.yaml"));
  let report;
  try {
    const migrationTables = parseMigrationDir(migrationsDir);
    const inventory = parseInventory(readFileSync(inventoryFile, "utf8"));
    const result = checkInventory(migrationTables, inventory);
    report = {
      ok: result.missing.length === 0,
      migrations: [...new Set(migrationTables.map((t) => t.file))],
      tables: [...new Set(migrationTables.map((t) => t.table))],
      checked: result.checked,
      missing: result.missing,
      unclassified: result.unclassified,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`check-data-inventory: ${message}\n`);
    return 2;
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `Parsed ${report.migrations.length} migration(s), ${report.tables.length} table(s), ${report.checked} column(s).\n`,
    );
    for (const m of report.missing) process.stdout.write(`MISSING ${m.table}.${m.column} (${m.file})\n`);
    for (const u of report.unclassified) process.stdout.write(`UNCLASSIFIED ${u.table}.${u.column} (pii_class TODO)\n`);
    process.stdout.write(
      report.ok ? "OK: every migration column has a data_inventory.yaml row.\n" : `FAIL: ${report.missing.length} column(s) untagged.\n`,
    );
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
