import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { AppModule } from "./app.module";
import { ConfigError, loadConfig } from "./config/env";
import { MissingDatabaseConfigError, createPersistence } from "./persistence";
import { createPgliteDatabase, type PgliteInstance } from "./platform/db";
import { createTestDatabaseUpTo } from "@outlet/db";

const KEY = "k".repeat(32);

describe("persistence composition", () => {
  it("requires DATABASE_URL and the pseudonym key once fixtures are off", () => {
    expect(() => loadConfig({ NODE_ENV: "development", DEV_FIXTURES: "false" })).toThrow(ConfigError);
    const cfg = loadConfig({
      NODE_ENV: "development",
      DEV_FIXTURES: "false",
      DATABASE_URL: "postgres://app@localhost/outlet",
      SIZE_DEMAND_PSEUDONYM_KEY: KEY,
    });
    expect(cfg.adapters).toBe("production");
    expect(cfg.databaseUrl).toBe("postgres://app@localhost/outlet");
  });

  it("builds every Postgres adapter over one injected handle", { timeout: 60_000 }, async () => {
    const raw = await createTestDatabaseUpTo(20);
    const db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
    const cfg = loadConfig({
      NODE_ENV: "development",
      DEV_FIXTURES: "false",
      DATABASE_URL: "postgres://app@localhost/outlet",
      SIZE_DEMAND_PSEUDONYM_KEY: KEY,
    });
    const p = createPersistence(cfg, db);
    expect(p.inventory.store).toBeDefined();
    expect(p.notifications.repositories.templates).toBeDefined();
    expect(p.sizing.repositories?.demand).toBeDefined();
    expect(p.cart.repository).toBeDefined();
    expect(p.orders.repository).toBeDefined();
    expect(p.returns.repository).toBeDefined();
    expect(p.promotions.repository).toBeDefined();
    expect(p.fulfillment.repository).toBeDefined();
    expect(p.search.savedSearches).toBeDefined();
    expect(p.money.ledger.store).toBeDefined();
    expect(p.money.ledger.uow.run).toBeTypeOf("function");
    expect(p.money.payments.store).toBeDefined();
    expect(p.money.checkout.repository).toBeDefined();
    expect(p.money.refunds.store).toBeDefined();
    expect(p.money.storeCredit.store).toBeDefined();
    expect(p.money.payouts.store).toBeDefined();
    expect(p.money.reconciliation.store).toBeDefined();
  });

  it("fails loudly when the database config is missing", () => {
    const cfg = { ...loadConfig({ NODE_ENV: "test" }), adapters: "production" as const };
    expect(() => createPersistence(cfg)).toThrow(MissingDatabaseConfigError);
  });

  it("dev boot composes with explicit fixtures; the production composition now replaces the old refusal", async () => {
    expect(() => AppModule.register(loadConfig({ NODE_ENV: "development" }))).not.toThrow();
    const raw = await createTestDatabaseUpTo(20);
    const db = createPgliteDatabase<Record<string, never>>(raw as unknown as PgliteInstance);
    const cfg = loadConfig({
      NODE_ENV: "development",
      DEV_FIXTURES: "false",
      DATABASE_URL: "postgres://app@localhost/outlet",
      SIZE_DEMAND_PSEUDONYM_KEY: KEY,
    });
    expect(createPersistence(cfg, db)).toBeDefined();
    // The production composition (Postgres stores plus Unconfigured providers) replaces the refusal.
    expect(() => AppModule.register(cfg, {}, { production: { db } })).not.toThrow();
  });
});
