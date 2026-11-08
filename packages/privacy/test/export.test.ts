import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  DuplicateOpenRequestError,
  ExportService,
  InvalidTransitionError,
  RequestNotFoundError,
  UserNotFoundError,
  groupByTable,
  loadExportFields,
} from "../src/index.js";
import type { ExportBuilderPort, ExportField } from "../src/index.js";
import { events, insertUser, setupEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
beforeEach(async () => {
  env = await setupEnv();
});
afterEach(async () => {
  await env.close();
});
const HOUR = 3_600_000;
const noFields = (): Promise<ExportField[]> => Promise.resolve([]);
const row = async (id: string): Promise<Record<string, unknown>> =>
  (await env.client.query("SELECT * FROM privacy_requests WHERE id = $1", [id])).rows[0] ?? {};

describe("ExportService", () => {
  it("queues with a 72h due date, then completes with a 24h link", async () => {
    const u = await insertUser(env.client);
    const svc = new ExportService(env.deps, noFields);
    const r = await svc.request(u);
    expect(r.status).toBe("RECEIVED");
    expect(r.dueAt.getTime() - env.clock.t).toBeGreaterThan(72 * HOUR - 1000);
    expect(r.dueAt.getTime() - env.clock.t).toBeLessThanOrEqual(72 * HOUR);
    await expect(svc.request(u)).rejects.toBeInstanceOf(DuplicateOpenRequestError);
    await svc.start(r.id);
    const { expiresAt } = await svc.complete(r.id, "exports/a.zip");
    const saved = await row(r.id);
    expect(saved).toMatchObject({ status: "COMPLETED", export_object_key: "exports/a.zip" });
    expect(expiresAt.getTime() - env.clock.t).toBeLessThanOrEqual(24 * HOUR);
    expect(expiresAt.getTime() - env.clock.t).toBeGreaterThan(24 * HOUR - 1000);
    const ev = await events(env.client, "privacy.export_ready");
    expect(ev).toHaveLength(1);
    await expect(svc.complete(r.id, "x")).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(svc.start(r.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    await svc.request(u); // a new export is allowed once the old one is done
  });

  it("is idempotent per key; unknown user and unknown request are typed errors", async () => {
    const u = await insertUser(env.client);
    const svc = new ExportService(env.deps, noFields);
    const key = "01900000-0000-7000-8000-00000000000b";
    expect((await svc.request(u, key)).id).toBe((await svc.request(u, key)).id);
    await expect(svc.request("01900000-0000-7000-8000-0000000000aa")).rejects.toBeInstanceOf(UserNotFoundError);
    await expect(svc.complete("01900000-0000-7000-8000-0000000000cc", "k")).rejects.toBeInstanceOf(RequestNotFoundError);
  });

  it("run() builds with the inventory field list then completes", async () => {
    const u = await insertUser(env.client);
    const seen: ExportField[][] = [];
    const builder: ExportBuilderPort = {
      build: (_s, fields) => {
        seen.push([...fields]);
        return Promise.resolve({ objectKey: "exports/z.zip" });
      },
    };
    const svc = new ExportService(env.deps, () => loadExportFields(), builder);
    const r = await svc.request(u);
    await svc.run(r.id);
    expect(await row(r.id)).toMatchObject({ status: "COMPLETED", export_object_key: "exports/z.zip" });
    expect(seen[0]?.length).toBeGreaterThan(50);
  });

  it("run() without a builder or for a missing request fails clearly", async () => {
    const svc = new ExportService(env.deps, noFields);
    await expect(svc.run("01900000-0000-7000-8000-0000000000cc")).rejects.toThrow(/no ExportBuilderPort/);
    const withB = new ExportService(env.deps, noFields, { build: () => Promise.resolve({ objectKey: "k" }) });
    await expect(withB.run("01900000-0000-7000-8000-0000000000cc")).rejects.toBeInstanceOf(RequestNotFoundError);
  });
});

describe("inventory loader", () => {
  it("lists P2/P3 columns grouped by table, including users.phone_ct and size_profiles.measurements_ct", async () => {
    const fields = await loadExportFields();
    expect(fields.every((f) => ["P2", "P3"].includes(f.piiClass))).toBe(true);
    const by = groupByTable(fields);
    const users = by.get("users") ?? [];
    expect(users.find((f) => f.column === "phone_ct")).toMatchObject({ piiClass: "P3" });
    expect(users.find((f) => f.column === "dob_ct")?.piiClass).toBe("P3");
    expect(users.find((f) => f.column === "market_id")).toBeUndefined(); // P1 is out of scope
    expect(by.get("size_profiles")?.find((f) => f.column === "measurements_ct")).toMatchObject({ piiClass: "P3" });
    expect(fields.filter((f) => f.piiClass === "P3").length).toBeGreaterThanOrEqual(15);
  });

  it("rejects a malformed inventory and tolerates a missing retention", async () => {
    const dir = await mkdtemp(join(tmpdir(), "inv-"));
    const bad = join(dir, "bad.yaml");
    await writeFile(bad, "tables: nope\n");
    await expect(loadExportFields(bad)).rejects.toThrow();
    const ok = join(dir, "ok.yaml");
    await writeFile(ok, 'tables:\n  - name: t\n    columns:\n      - {name: a, pii_class: P2}\n      - {name: b, pii_class: P0}\n');
    expect(await loadExportFields(ok)).toEqual([{ table: "t", column: "a", piiClass: "P2", retention: null }]);
    expect(dirname(ok)).toBe(dir);
    expect(fileURLToPath(new URL("file:///x"))).toBe("/x");
  });
});
