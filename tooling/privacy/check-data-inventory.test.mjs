import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkInventory, main, parseInventory, parseMigrationSql } from "./check-data-inventory.mjs";

const ROOT = resolve(import.meta.dirname, "..", "..");

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inventory-check-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const inventoryYaml = (rows) =>
  [
    "inventory_version: 1",
    "tables:",
    "  - name: users",
    "    module: auth",
    "    columns:",
    ...rows.map((name) => `      - {name: "${name}", type: "text", pii_class: P2, encryption: none}`),
    "",
  ].join("\n");

const fixtureMigrations = (sql) => {
  const migrations = join(dir, "migrations");
  mkdirSync(migrations);
  writeFileSync(join(migrations, "0001_fixture.sql"), sql);
  return migrations;
};

describe("parseMigrationSql", () => {
  it("returns top-level column names and ignores constraints, comments and indexes", () => {
    const sql = `
      -- CREATE TABLE ignored (fake int);
      CREATE TABLE users (
        id uuid PRIMARY KEY,            -- UUIDv7
        amount numeric(12, 2) NOT NULL CHECK (amount > 0),
        "Quoted Col" text,
        status text NOT NULL DEFAULT 'a,b',
        CONSTRAINT users_status_chk CHECK (status IN ('a', 'b')),
        UNIQUE (id)
      );
      CREATE INDEX users_status_idx ON users (status);
    `;
    expect(parseMigrationSql(sql)).toEqual([{ table: "users", columns: ["id", "amount", "Quoted Col", "status"] }]);
  });

  it("picks up ADD COLUMN in ALTER TABLE statements", () => {
    expect(parseMigrationSql("ALTER TABLE users ADD COLUMN nickname text;")).toEqual([{ table: "users", columns: ["nickname"] }]);
  });
});

describe("parseInventory", () => {
  it("maps table -> column -> pii_class from the tables section only", () => {
    const map = parseInventory(inventoryYaml(["id", "phone_ct"]));
    expect(map.get("users")).toEqual(new Map([["id", "P2"], ["phone_ct", "P2"]]));
  });
});

describe("checkInventory", () => {
  it("reports a column that has no inventory row", () => {
    const tables = parseMigrationSql("CREATE TABLE users (id uuid, secret text);");
    const result = checkInventory(tables, parseInventory(inventoryYaml(["id"])));
    expect(result.missing).toEqual([{ table: "users", column: "secret", file: undefined }]);
  });

  it("lists TODO columns as unclassified without failing", () => {
    const tables = parseMigrationSql("CREATE TABLE users (id uuid);");
    const inv = parseInventory(inventoryYaml(["id"]).replace("pii_class: P2", "pii_class: TODO"));
    const result = checkInventory(tables, inv);
    expect(result.missing).toEqual([]);
    expect(result.unclassified).toEqual([{ table: "users", column: "id" }]);
  });
});

describe("main (CLI behaviour)", () => {
  it("exits 1 for a fixture migration with an untagged column", () => {
    const migrations = fixtureMigrations("CREATE TABLE users (id uuid, untagged_col text);");
    const inventory = join(dir, "inventory.yaml");
    writeFileSync(inventory, inventoryYaml(["id"]));
    expect(main(["--migrations", migrations, "--inventory", inventory], ROOT)).toBe(1);
  });

  it("exits 0 for a fixture migration whose columns are all tagged, and --json is valid JSON", () => {
    const migrations = fixtureMigrations("CREATE TABLE users (id uuid, secret text);");
    const inventory = join(dir, "inventory.yaml");
    writeFileSync(inventory, inventoryYaml(["id", "secret"]));
    const chunks = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      chunks.push(String(chunk));
      return true;
    };
    try {
      expect(main(["--json", "--migrations", migrations, "--inventory", inventory], ROOT)).toBe(0);
    } finally {
      process.stdout.write = original;
    }
    const report = JSON.parse(chunks.join(""));
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(2);
  });

  it("passes against the repository's migrations and data_inventory.yaml", () => {
    expect(main([], ROOT)).toBe(0);
  });
});
