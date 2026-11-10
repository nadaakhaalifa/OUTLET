import { afterEach, describe, expect, it } from "vitest";
import { contextClient } from "@outlet/db";
import { roleClient } from "@outlet/db/testing";
import { ConsentService } from "@outlet/privacy";
import { MarketingChannelUnsupportedError, PreferencesService } from "../src/index.js";
import { insertUser, setupEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
afterEach(async () => {
  await env.close();
});

const svc = (userId: string) => {
  const db = contextClient(roleClient(env.client, "outlet_app"), { kind: "user", marketId: "EG", userId });
  return { db, p: new PreferencesService(db, new ConsentService({ db, outbox: env.outbox })), consent: new ConsentService({ db, outbox: env.outbox }) };
};

describe("PreferencesService", () => {
  it("enable then one-call withdraw updates both the preference and the consent purpose", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    const { p, consent } = svc(u);
    await p.enableMarketing(u, "whatsapp");
    expect(await consent.isGranted(u, "marketing_whatsapp")).toBe(true);
    expect(await p.list(u)).toEqual([{ channel: "whatsapp", category: "marketing", enabled: true }]);
    await p.withdrawMarketing(u, "whatsapp");
    await p.withdrawMarketing(u, "whatsapp"); // idempotent
    expect(await consent.isGranted(u, "marketing_whatsapp")).toBe(false);
    expect(await p.list(u)).toEqual([{ channel: "whatsapp", category: "marketing", enabled: false }]);
  });

  it("sms has no marketing purpose; transactional channels can be muted", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    const { p } = svc(u);
    await expect(p.enableMarketing(u, "sms")).rejects.toBeInstanceOf(MarketingChannelUnsupportedError);
    await p.withdrawMarketing(u, "sms");
    await p.setTransactional(u, "push", false);
    expect((await p.list(u)).map((r) => [r.channel, r.category, r.enabled])).toEqual([["push", "transactional", false], ["sms", "marketing", false]]);
  });

  it("one user cannot read or change another user's preferences (RLS)", async () => {
    env = await setupEnv();
    const a = await insertUser(env.client);
    const b = await insertUser(env.client);
    await svc(b).p.setTransactional(b, "push", false);
    expect(await svc(a).p.list(b)).toEqual([]);
    await expect(svc(a).p.setTransactional(b, "email", false)).rejects.toThrow();
    await expect(svc(a).p.withdrawMarketing(b, "push")).rejects.toThrow();
  });

  it("rejects an unknown user", async () => {
    env = await setupEnv();
    const a = await insertUser(env.client);
    const { p } = svc(a);
    await expect(p.setTransactional("01900000-0000-7000-8000-0000000000ff", "push", true)).rejects.toThrow();
  });
});
