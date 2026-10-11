import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModuleRef } from "@nestjs/core";
import { loadConfig } from "../config/env";
import { MODULE_BINDINGS, unboundModuleDirs } from "./bindings";
import { composeProduction, PRODUCTION_RUNTIME } from "./compose";
import { bootProduction, newTestDb, PROD_ENV, type ProductionTestApp } from "./test/test-support";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("production composition registry", () => {
  let booted: ProductionTestApp;
  beforeAll(async () => {
    booted = await bootProduction();
  }, 120_000);
  afterAll(async () => {
    await booted.app.close();
  });

  it("every module directory has an explicit production binding (a new module without one fails here)", () => {
    expect(unboundModuleDirs(join(SRC, "modules"))).toEqual([]);
  });

  it("every binding row refers to a module directory that exists", () => {
    const dirs = new Set(readdirSync(join(SRC, "modules"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
    expect(Object.keys(MODULE_BINDINGS).filter((id) => !dirs.has(id))).toEqual([]);
  });

  it("a blocked module always carries a reason", () => {
    for (const [id, b] of Object.entries(MODULE_BINDINGS)) {
      if (b.status === "blocked") expect(b.reason.length, id).toBeGreaterThan(40);
    }
  });

  it("composes exactly one import per composed module plus the auth stand-in, money bridge and runtime", async () => {
    const config = loadConfig({ ...PROD_ENV });
    const db = await newTestDb();
    const c = composeProduction(config, { db });
    const composed = Object.values(MODULE_BINDINGS).filter((b) => b.status === "composed").length;
    expect(c.imports.length).toBe(composed + 3);
  }, 60_000);

  it("the whole graph boots over PGlite with real stores and exposes the worker runtime", () => {
    const runtime = booted.app.get<{ db: unknown; paymentEvents: unknown }>(PRODUCTION_RUNTIME, { strict: false });
    expect(runtime.db).toBeDefined();
    expect(runtime.paymentEvents).toBeDefined();
    expect(booted.app.get(ModuleRef)).toBeDefined();
  });

  it("no dev fixture token leaks into the production graph", () => {
    // The dev OTP mailbox only exists in the dev auth module, which production does not import.
    expect(() => booted.app.get("DEV_OTP_MAILBOX", { strict: false })).toThrow();
  });
});
