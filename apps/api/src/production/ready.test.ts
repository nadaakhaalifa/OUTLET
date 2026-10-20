import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "kysely";
import { MODULE_BINDINGS } from "./bindings";
import { bootProduction, type ProductionTestApp } from "./test/test-support";
import { PROVIDERS } from "./unconfigured";

describe("GET /v1/ready and /v1/health under the production composition", () => {
  let t: ProductionTestApp;
  beforeAll(async () => {
    t = await bootProduction();
  }, 120_000);
  afterAll(async () => {
    await t.app.close();
  });

  const http = (): ReturnType<typeof request> => request(t.app.getHttpServer());

  it("health is liveness only", async () => {
    const r = await http().get("/v1/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok" });
  });

  it("ready reports the database, the outbox and every provider honestly", async () => {
    const r = await http().get("/v1/ready");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ready");
    expect(r.body.checks).toEqual({ database: "ok" });
    expect(Object.keys(r.body.providers).sort()).toEqual(Object.keys(PROVIDERS).sort());
    for (const v of Object.values(r.body.providers)) expect(["configured", "unconfigured"]).toContain(v);
    expect(r.body.providers["psp.paymob"]).toBe("unconfigured");
    expect(r.body.providers["flags.provider"]).toBe("unconfigured");
    expect(r.body.dependencies.outbox).toEqual({ state: "ok", pending: 0, oldest_age_seconds: 0, dead_lettered: 0 });
    expect(r.body.modules.blocked.sort()).toEqual(
      Object.entries(MODULE_BINDINGS).filter(([, b]) => b.status === "blocked").map(([id]) => id).sort(),
    );
    expect(r.body.modules.composed).toBeGreaterThan(30);
  });

  it("ready carries names and counters only (no secrets, no connection strings)", async () => {
    const r = await http().get("/v1/ready");
    const text = JSON.stringify(r.body);
    expect(text).not.toMatch(/postgres:|db\.invalid|ppppp|aaaaa|kkkkk/);
  });

  it("outbox lag turns lagging when an old event is unpublished", async () => {
    await sql`SELECT set_config('app.role', 'system', false)`.execute(t.db);
    await sql`INSERT INTO outbox_events (id, occurred_at, aggregate_type, aggregate_id, event_type, payload)
      VALUES ('0190a000-0000-7000-8000-000000000001', now() - interval '1 hour', 'x', '0190a000-0000-7000-8000-000000000002', 'x.created', '{}'::jsonb)`.execute(t.db);
    const r = await http().get("/v1/ready");
    expect(r.body.dependencies.outbox.state).toBe("lagging");
    expect(r.body.dependencies.outbox.pending).toBe(1);
    expect(r.body.dependencies.outbox.oldest_age_seconds).toBeGreaterThan(3000);
    // Lag is reported, but does not make the API unready: only the database gates readiness.
    expect(r.status).toBe(200);
  });

  it("unauthenticated requests to protected routes fail closed with 401 (auth is composed; no signing keys are configured)", async () => {
    expect((await http().get("/v1/me/sessions")).status).toBe(401);
    expect((await http().get("/v1/me")).status).toBe(401);
    expect((await http().get("/v1/me").set("Authorization", "Bearer dev_x")).status).toBe(401);
  });
});
