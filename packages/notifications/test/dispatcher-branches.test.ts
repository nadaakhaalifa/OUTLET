import { afterEach, describe, expect, it } from "vitest";
import { roleClient } from "@outlet/db/testing";
import { uuidv7 } from "@outlet/ids";
import { ConsentService } from "@outlet/privacy";
import { Dispatcher } from "../src/index.js";
import type { ChannelPort, Channel } from "../src/index.js";
import { event, insertStore, insertUser, logRows, setupEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
afterEach(async () => {
  await env.close();
});

const rejected = (u: string, storeId: string) => event("seller_order.rejected", u, { store_id: storeId, seller_order_id: uuidv7(), order_group_id: uuidv7(), reason_code: "out_of_stock" });

describe("store name in the seller-rejection notice", () => {
  it("falls back to the generic store word for a malformed store id, in each language", async () => {
    env = await setupEnv();
    const ar = await insertUser(env.client);
    const en = await insertUser(env.client, "en-EG");
    const d = env.dispatcher();
    await d.handle(rejected(ar, "not-a-uuid"));
    await d.handle(rejected(en, "not-a-uuid"));
    await d.runDue("EG", 100);
    expect(env.fakes.push.sent.find((m) => m.userId === ar)?.body.startsWith("المتجر")).toBe(true);
    expect(env.fakes.push.sent.find((m) => m.userId === en)?.body).toContain("the store");
  });

  it("an English reader of a store with no English name sees the Arabic name; an unknown store falls back for an English reader", async () => {
    env = await setupEnv();
    const en = await insertUser(env.client, "en-EG");
    const en2 = await insertUser(env.client, "en-EG");
    const store = await insertStore(env.client, { ar: "متجر النيل", en: null });
    const d = env.dispatcher();
    await d.handle(rejected(en, store));
    await d.handle(rejected(en2, uuidv7()));
    await d.runDue("EG", 100);
    expect(env.fakes.push.sent.find((m) => m.userId === en)?.body).toContain("متجر النيل");
    expect(env.fakes.push.sent.find((m) => m.userId === en2)?.body).toContain("the store");
  });
});

describe("locale", () => {
  it("a user locale the templates do not support is served in Arabic", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client, "fr-FR");
    const d = env.dispatcher();
    await d.handle(event("order_group.paid", u, { total_minor: "250000", currency: "EGP" }));
    await d.runDue("EG");
    expect(env.fakes.push.sent[0]?.locale).toBe("ar-EG");
  });
});

describe("delivery-time decisions and options", () => {
  const seed = async (): Promise<void> => {
    await env.client.query(
      `INSERT INTO notification_templates (id, market_id, code, channel, locale, category, title, body, provider_template_name) VALUES
        (gen_random_uuid(),'EG','price_drop','push','ar-EG','marketing','نزل السعر','السعر نزل لـ {price} ج.م',NULL)`,
    );
  };
  const req = (u: string, key: string) => ({ userId: u, marketId: "EG", templateCode: "price_drop", dedupeKey: key, vars: { price: "99" } });

  it("a queued marketing row that falls into quiet hours before it is sent is rescheduled to 09:00, not sent", async () => {
    env = await setupEnv();
    await seed();
    const u = await insertUser(env.client);
    await new ConsentService({ db: env.client, outbox: env.outbox }).grant(u, "marketing_push", { method: "settings" });
    const d = env.dispatcher();
    await d.enqueueMarketing(req(u, "late")); // noon Cairo: queued for now
    env.clock.t = Date.UTC(2026, 10, 8, 21, 30); // 23:30 Cairo
    expect(await d.runDue("EG")).toBe(1);
    expect(env.fakes.push.sent).toHaveLength(0);
    const row = (await logRows(env.client, u))[0];
    expect(row).toMatchObject({ status: "queued" });
    expect(row?.scheduled_for.toISOString()).toBe("2026-11-09T07:00:00.000Z");
    env.clock.t = Date.UTC(2026, 10, 9, 7, 0);
    expect(await d.runDue("EG")).toBe(1);
    expect(env.fakes.push.sent).toHaveLength(1);
  });

  it("honours a custom quiet-hours window: noon is quiet when the window is 11 to 13", async () => {
    env = await setupEnv();
    await seed();
    const u = await insertUser(env.client);
    await new ConsentService({ db: env.client, outbox: env.outbox }).grant(u, "marketing_push", { method: "settings" });
    await env.dispatcher({ quietHours: { startHour: 11, endHour: 13 } }).enqueueMarketing(req(u, "q"));
    const row = (await logRows(env.client, u))[0];
    expect(row).toMatchObject({ status: "queued" });
    expect(row?.scheduled_for.toISOString()).toBe("2026-11-08T11:00:00.000Z"); // 13:00 Cairo
  });

  it("an empty transactional chain still writes the in-app copy and nothing outbound", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    const d = env.dispatcher({ transactionalChain: [] });
    expect(await d.handle(event("order_group.paid", u, { total_minor: "100", currency: "EGP" }))).toBe("processed");
    expect((await logRows(env.client, u)).map((r) => r.channel)).toEqual(["in_app"]);
  });

  it("two overlapping runDue sweeps send each row once and count it once", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    await d.handle(event("order_group.paid", u, { total_minor: "100", currency: "EGP" }));
    const [a, b] = await Promise.all([d.runDue("EG"), d.runDue("EG")]);
    expect(a + b).toBe(2);
    expect(env.fakes.push.sent).toHaveLength(1);
    expect((await logRows(env.client, u)).map((r) => r.status)).toEqual(["sent", "sent"]);
  });

  it("a dispatcher built with only the required ports uses real clock, ids and defaults", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    const channels = Object.fromEntries(Object.entries(env.fakes).map(([k, v]) => [k, [v as ChannelPort]])) as Record<Channel, ChannelPort[]>;
    const d = new Dispatcher({ db: roleClient(env.client, "outlet_worker"), outbox: env.outbox, channels, killSwitch: env.kill, consentFor: (db) => new ConsentService({ db, outbox: env.outbox }) });
    expect(await d.handle({ ...event("order_group.paid", u, { total_minor: "100", currency: "EGP" }), occurredAt: new Date().toISOString() })).toBe("processed");
    const rows = await logRows(env.client, u);
    expect(rows.map((r) => r.channel)).toEqual(["in_app", "push"]);
    expect(await d.runDue("EG")).toBe(2);
    expect(env.fakes.push.sent).toHaveLength(1);
  });
});
