import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONSENT_PURPOSES, ConsentService, StaticConsentRegistry, UserNotFoundError } from "../src/index.js";
import { events, insertUser, setupEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
beforeEach(async () => {
  env = await setupEnv();
});
afterEach(async () => {
  await env.close();
});

describe("ConsentService", () => {
  it("a fresh user has every purpose not granted (no pre-ticked path)", async () => {
    const u = await insertUser(env.client);
    const svc = new ConsentService(env.deps);
    const all = await svc.current(u);
    expect(all.map((s) => s.purpose)).toEqual([...CONSENT_PURPOSES]);
    expect(all.every((s) => !s.granted && s.version === null && !s.stale)).toBe(true);
    for (const p of CONSENT_PURPOSES) expect(await svc.isGranted(u, p)).toBe(false);
  });

  it("grant then withdraw appends records and the latest wins", async () => {
    const u = await insertUser(env.client);
    const svc = new ConsentService(env.deps);
    await svc.grant(u, "analytics", { method: "onboarding", ipHmac: new Uint8Array(32) });
    expect(await svc.isGranted(u, "analytics")).toBe(true);
    expect(await svc.isGranted(u, "marketing_push")).toBe(false);
    await svc.withdraw(u, "analytics", { method: "settings" });
    expect(await svc.isGranted(u, "analytics")).toBe(false);
    const n = await env.client.query<{ n: number }>("SELECT count(*)::int AS n FROM consent_records WHERE user_id = $1", [u]);
    expect(n.rows[0]?.n).toBe(2);
    const st = await env.client.query<{ granted: boolean }>("SELECT granted FROM consent_state WHERE user_id = $1 AND purpose_code = 'analytics'", [u]);
    expect(st.rows).toEqual([{ granted: false }]);
  });

  it("emits consent.changed in the same transaction", async () => {
    const u = await insertUser(env.client);
    await new ConsentService(env.deps).grant(u, "measurements", { method: "api" });
    const ev = await events(env.client, "consent.changed");
    expect(ev).toHaveLength(1);
    expect(ev[0]?.payload).toMatchObject({ userId: u, purpose: "measurements", granted: true, method: "api", consentVersion: 1 });
  });

  it("rolls the event back with the record when the tx fails", async () => {
    const u = await insertUser(env.client);
    const dup = "01900000-0000-7000-8000-000000000001";
    await env.client.query("INSERT INTO consent_records (id, market_id, user_id, purpose_code, purpose_version, granted, method, recorded_at) VALUES ($1,'EG',$2,'analytics',1,false,'api',now())", [dup, u]);
    const svc = new ConsentService({ ...env.deps, newId: () => dup });
    await expect(svc.grant(u, "analytics", { method: "api" })).rejects.toThrow();
    expect(await events(env.client)).toHaveLength(0);
    const n = await env.client.query<{ n: number }>("SELECT count(*)::int AS n FROM consent_records");
    expect(n.rows[0]?.n).toBe(1);
  });

  it("a failing outbox append leaves no consent record", async () => {
    const u = await insertUser(env.client);
    const bad = { append: () => Promise.reject(new Error("outbox down")) } as unknown as typeof env.deps.outbox;
    await expect(new ConsentService({ ...env.deps, outbox: bad }).grant(u, "analytics", { method: "api" })).rejects.toThrow("outbox down");
    const n = await env.client.query<{ n: number }>("SELECT count(*)::int AS n FROM consent_records");
    expect(n.rows[0]?.n).toBe(0);
  });

  it("a new text version invalidates old grants unless configured to keep them", async () => {
    const u = await insertUser(env.client);
    await new ConsentService(env.deps).grant(u, "analytics", { method: "banner" });
    await new ConsentService(env.deps).grant(u, "personalization", { method: "banner" });
    const v2 = new ConsentService(env.deps, new StaticConsentRegistry({ versions: { analytics: 2, personalization: 2 }, keepOldGrants: ["personalization"] }));
    expect(await v2.isGranted(u, "analytics")).toBe(false);
    expect((await v2.current(u)).find((s) => s.purpose === "analytics")).toMatchObject({ stale: true, granted: false, version: 1 });
    expect(await v2.isGranted(u, "personalization")).toBe(true);
    await v2.grant(u, "analytics", { method: "settings" });
    expect(await v2.isGranted(u, "analytics")).toBe(true);
  });

  it("explicit version override is recorded", async () => {
    const u = await insertUser(env.client);
    const svc = new ConsentService(env.deps);
    await svc.grant(u, "analytics", { method: "api", version: 3 });
    expect((await svc.current(u)).find((s) => s.purpose === "analytics")?.version).toBe(3);
  });

  it("unknown user is a typed error", async () => {
    const svc = new ConsentService(env.deps);
    const ghost = "01900000-0000-7000-8000-0000000000aa";
    await expect(svc.grant(ghost, "analytics", { method: "api" })).rejects.toBeInstanceOf(UserNotFoundError);
    await expect(svc.current(ghost)).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("consent_records rejects UPDATE and DELETE even for a non-superuser role", async () => {
    const u = await insertUser(env.client);
    await new ConsentService(env.deps).grant(u, "analytics", { method: "api" });
    await env.client.query("CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS");
    await env.client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON consent_records TO app_user");
    await env.client.query("SET ROLE app_user");
    await env.client.query("SELECT set_config('app.current_user_id', $1, false)", [u]); // 0006 forces user RLS: the trigger must fire on a visible row
    await expect(env.client.query("UPDATE consent_records SET granted = false")).rejects.toThrow(/append-only/);
    await expect(env.client.query("DELETE FROM consent_records")).rejects.toThrow(/append-only/);
    await env.client.query("RESET ROLE");
    // superuser is also blocked by the trigger, and TRUNCATE too
    await expect(env.client.query("UPDATE consent_records SET granted = false")).rejects.toThrow(/append-only/);
    await expect(env.client.query("TRUNCATE consent_records")).rejects.toThrow(/append-only/);
  });
});
