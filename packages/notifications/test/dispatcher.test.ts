import { afterEach, describe, expect, it } from "vitest";
import { asRole } from "@outlet/db/testing";
import { applyDbContext } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { ConsentService } from "@outlet/privacy";
import { CHANNEL_KILL_SWITCH_NAMES, NOTIFYING_EVENT_TYPES } from "../src/index.js";
import { event, insertMember, insertStore, insertUser, logRows, NOON, setupEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
afterEach(async () => {
  await env.close();
});

const paid = (u: string | undefined) => event("order_group.paid", u, { total_minor: "250000", currency: "EGP" });

describe("transactional dispatch", () => {
  it("renders Arabic copy for an Arabic user, sends in-app and push, no consent needed, logs without the body", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    expect(await d.handle(paid(u))).toBe("processed");
    expect(await d.runDue("EG")).toBe(2);
    expect((await logRows(env.client, u)).map((r) => [r.channel, r.status])).toEqual([["in_app", "sent"], ["push", "sent"]]);
    const msg = env.fakes.push.sent[0];
    expect(msg?.locale).toBe("ar-EG");
    expect(msg?.body).toContain("اتأكد دفع");
    expect(msg?.body).toContain("ج.م");
    expect(msg?.body).not.toMatch(/\{|order_paid/);
    // No PII / body in the log table or the logger output.
    const dump = JSON.stringify((await env.client.query("SELECT * FROM notification_log")).rows) + env.logs.join("\n");
    expect(dump).not.toContain("اتأكد دفع");
    // delivery events were emitted
    const ev = await env.client.query("SELECT event_type FROM outbox_events WHERE event_type = 'notification.delivered'");
    expect(ev.rows).toHaveLength(2);
  });

  it("falls back to English copy for an English user", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client, "en-EG");
    const d = env.dispatcher();
    await d.handle(paid(u));
    await d.runDue("EG");
    expect(env.fakes.push.sent[0]?.body).toBe("Your payment of EGP 2,500 is confirmed, thank you. The sellers are preparing your order.");
  });

  it("is idempotent: the same event twice sends once", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    const e = paid(u);
    expect(await d.handle(e)).toBe("processed");
    expect(await d.handle(e)).toBe("duplicate");
    await d.runDue("EG");
    expect(await d.runDue("EG")).toBe(0);
    expect(env.fakes.push.sent).toHaveLength(1);
    // a redelivery under a new inbox id still cannot duplicate rows (dedupe_key)
    expect(await logRows(env.client, u)).toHaveLength(2);
  });

  it("renders the Arabic cancellation notice for order_group.cancelled without placeholders", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    expect(await d.handle(event("order_group.cancelled", u, { reason_code: "changed_mind", refund_expected: true, currency: "EGP" }))).toBe("processed");
    expect(await d.runDue("EG")).toBe(2);
    const msg = env.fakes.push.sent[0];
    expect(msg?.title).toBe("اتلغى طلبك");
    expect(msg?.body).not.toMatch(/\{|order_cancelled/);
  });

  it("maps every notifying event type and ignores the rest or an unresolved recipient", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    const store = await insertStore(env.client);
    await insertMember(env.client, store, u, "owner");
    for (const t of NOTIFYING_EVENT_TYPES) expect(await d.handle(event(t, u, { total_minor: "100", amount_minor: "100", currency: "EGP", store_id: store, initiator: "shopper" }))).toBe("processed");
    expect(await d.handle(event("order_group.expired", u))).toBe("ignored");
    expect(await d.handle(paid(undefined))).toBe("unresolved");
    expect(await d.runDue("EG", 100)).toBe(NOTIFYING_EVENT_TYPES.length * 2);
  });

  it("fails over provider -> provider on the same channel, then retries with backoff, then channel failover", async () => {
    env = await setupEnv({ push: ["provider_error"] });
    const second = new (env.fakes.push.constructor as new (n: string) => typeof env.fakes.push)("push-b");
    const u = await insertUser(env.client);
    const d = env.dispatcher({ channels: { push: [env.fakes.push, second], in_app: [env.fakes.in_app], whatsapp: [env.fakes.whatsapp], sms: [env.fakes.sms], email: [env.fakes.email] } });
    await d.handle(paid(u));
    await d.runDue("EG");
    expect(second.sent).toHaveLength(1); // provider B took over in the same attempt
    expect((await logRows(env.client, u)).find((r) => r.channel === "push")).toMatchObject({ status: "sent", provider: "push-b" });
  });

  it("retries transient failures with exponential backoff, then moves to the next channel", async () => {
    env = await setupEnv({ push: ["provider_error", "provider_error", "provider_error"] });
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    await d.handle(paid(u));
    await d.runDue("EG"); // attempt 1 fails -> requeued 30 s later
    expect((await logRows(env.client, u)).find((r) => r.channel === "push")).toMatchObject({ status: "queued", attempts: 1 });
    expect(await d.runDue("EG")).toBe(0); // not due yet
    env.clock.t += 31_000;
    await d.runDue("EG"); // attempt 2 -> backoff 60 s
    env.clock.t += 61_000;
    await d.runDue("EG"); // attempt 3 exhausts -> fails over to whatsapp (pending template -> rejected) -> sms
    const rows = await logRows(env.client, u);
    expect(rows.find((r) => r.status === "sent" && r.channel !== "in_app")).toMatchObject({ channel: "sms", error_code: "template_rejected" });
    expect(env.fakes.sms.sent).toHaveLength(1);
    expect(env.fakes.whatsapp.sent).toHaveLength(0);
  });

  it("WhatsApp template rejection falls back to SMS for transactional", async () => {
    env = await setupEnv({ push: ["no_destination"], whatsapp: ["template_rejected"] });
    await env.client.query("UPDATE notification_templates SET approval_status = 'approved' WHERE channel = 'whatsapp'");
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    await d.handle(paid(u));
    await d.runDue("EG");
    expect(env.fakes.whatsapp.sent).toHaveLength(1);
    expect(env.fakes.sms.sent).toHaveLength(1);
    expect(env.fakes.whatsapp.sent[0]?.providerTemplateName).toBe("outlex_order_paid_ar");
  });

  it("a killed channel is skipped for transactional (failover) and recorded as killed when nothing is left", async () => {
    env = await setupEnv();
    env.kill.killed.add("push").add("whatsapp");
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    await d.handle(paid(u));
    await d.runDue("EG");
    expect(env.fakes.push.sent).toHaveLength(0);
    expect(env.fakes.sms.sent).toHaveLength(1);
    for (const c of ["in_app", "sms", "email"] as const) env.kill.killed.add(c);
    const u2 = await insertUser(env.client);
    await d.handle(paid(u2));
    expect((await logRows(env.client, u2)).every((r) => r.status === "suppressed" && r.suppression_reason === "killed")).toBe(true);
  });

  it("all channels failing ends as failed with a notification.failed event", async () => {
    env = await setupEnv({ push: ["no_destination"], sms: ["no_destination"], email: ["no_destination"], in_app: ["no_destination"] });
    await env.client.query("UPDATE notification_templates SET approval_status = 'approved' WHERE channel = 'whatsapp'");
    env.fakes.whatsapp.send = () => Promise.resolve({ ok: false, code: "no_destination" });
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    await d.handle(paid(u));
    await d.runDue("EG");
    expect((await logRows(env.client, u)).every((r) => r.status === "failed" && r.error_code === "no_destination")).toBe(true);
    expect((await env.client.query("SELECT 1 FROM outbox_events WHERE event_type = 'notification.failed'")).rows).toHaveLength(2);
  });

  it("the user's own transactional mute suppresses that channel and the next channel is used", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    await env.client.query("INSERT INTO notification_preferences (user_id, channel, category, market_id, enabled) VALUES ($1,'push','transactional','EG',false)", [u]);
    const d = env.dispatcher();
    await d.handle(paid(u));
    await d.runDue("EG");
    expect(env.fakes.push.sent).toHaveLength(0);
    expect(env.fakes.sms.sent.length + env.fakes.whatsapp.sent.length).toBe(1);
  });
});

describe("marketing dispatch", () => {
  const req = (u: string, key: string, channels?: ("push" | "whatsapp" | "sms")[]) => ({ userId: u, marketId: "EG", templateCode: "price_drop", dedupeKey: key, vars: { price: "99" }, ...(channels ? { channels } : {}) });
  const seedMarketing = async (): Promise<void> => {
    await env.client.query(
      `INSERT INTO notification_templates (id, market_id, code, channel, locale, category, title, body, provider_template_name) VALUES
        (gen_random_uuid(),'EG','price_drop','push','ar-EG','marketing','نزل السعر','السعر نزل لـ {price} ج.م',NULL),
        (gen_random_uuid(),'EG','price_drop','whatsapp','ar-EG','marketing',NULL,'السعر نزل لـ {price} ج.م','outlex_price_drop_ar'),
        (gen_random_uuid(),'EG','price_drop','sms','ar-EG','marketing',NULL,'السعر نزل لـ {price} ج.م',NULL)`,
    );
  };

  it("is suppressed (consent) until the channel consent is granted, and never falls to SMS", async () => {
    env = await setupEnv();
    await seedMarketing();
    const u = await insertUser(env.client);
    const d = env.dispatcher();
    await d.enqueueMarketing(req(u, "k1", ["push", "sms"]));
    expect((await logRows(env.client, u)).map((r) => [r.channel, r.status, r.suppression_reason])).toEqual([["push", "suppressed", "consent"], ["sms", "suppressed", "consent"]]);
    await new ConsentService({ db: env.client, outbox: env.outbox }).grant(u, "marketing_push", { method: "settings" });
    await d.enqueueMarketing(req(u, "k2"));
    await d.runDue("EG");
    expect(env.fakes.push.sent).toHaveLength(1);
    expect(env.fakes.sms.sent).toHaveLength(0);
  });

  it("enforces the 1 push per day cap and defers quiet hours to 09:00 Cairo", async () => {
    env = await setupEnv();
    await seedMarketing();
    const u = await insertUser(env.client);
    await new ConsentService({ db: env.client, outbox: env.outbox }).grant(u, "marketing_push", { method: "settings" });
    const d = env.dispatcher();
    await d.enqueueMarketing(req(u, "a"));
    await d.runDue("EG");
    await d.enqueueMarketing(req(u, "b"));
    expect((await logRows(env.client, u)).map((r) => r.suppression_reason)).toEqual([null, "cap"]);
    // 23:30 Cairo next day -> deferred, then sent at 09:00 after the day cap window has passed
    env.clock.t = Date.UTC(2026, 10, 9, 21, 30);
    await d.enqueueMarketing(req(u, "c"));
    const row = (await logRows(env.client, u)).at(-1);
    expect(row).toMatchObject({ status: "queued" });
    expect(row?.scheduled_for.toISOString()).toBe("2026-11-10T07:00:00.000Z");
    expect(await d.runDue("EG")).toBe(0);
    env.clock.t = Date.UTC(2026, 10, 10, 7, 0);
    expect(await d.runDue("EG")).toBe(1);
    expect(env.fakes.push.sent).toHaveLength(2);
  });

  it("re-checks consent at send time: withdrawal after queueing suppresses", async () => {
    env = await setupEnv();
    await seedMarketing();
    const u = await insertUser(env.client);
    const consent = new ConsentService({ db: env.client, outbox: env.outbox });
    await consent.grant(u, "marketing_push", { method: "settings" });
    const d = env.dispatcher();
    env.clock.t = Date.UTC(2026, 10, 8, 21, 30);
    await d.enqueueMarketing(req(u, "w"));
    await consent.withdraw(u, "marketing_push", { method: "settings" });
    env.clock.t = Date.UTC(2026, 10, 9, 7, 1);
    await d.runDue("EG");
    expect(env.fakes.push.sent).toHaveLength(0);
    expect((await logRows(env.client, u))[0]).toMatchObject({ status: "suppressed", suppression_reason: "consent" });
  });

  it("a transactional template cannot be used as marketing (category must match)", async () => {
    env = await setupEnv();
    const u = await insertUser(env.client);
    await new ConsentService({ db: env.client, outbox: env.outbox }).grant(u, "marketing_push", { method: "settings" });
    const d = env.dispatcher();
    await d.enqueueMarketing({ userId: u, marketId: "EG", templateCode: "order_paid", dedupeKey: "x", vars: { amount: "1" } });
    await d.runDue("EG");
    expect(env.fakes.push.sent).toHaveLength(0);
    expect((await logRows(env.client, u))[0]).toMatchObject({ status: "failed", error_code: "template_rejected" });
  });
});

describe("tenancy and grants", () => {
  it("the user sees only their own log and preferences; worker without a narrowed user sees none of the user rows", async () => {
    env = await setupEnv();
    const a = await insertUser(env.client);
    const b = await insertUser(env.client);
    const d = env.dispatcher();
    await d.handle(paid(a));
    await d.handle(paid(b));
    const asUser = (id: string) => asRole(env.client, "outlet_app", async (tx) => {
      await applyDbContext(tx, { kind: "user", marketId: "EG", userId: id });
      return (await tx.query<{ user_id: string }>("SELECT user_id FROM notification_log")).rows;
    });
    expect((await asUser(a)).every((r) => r.user_id === a)).toBe(true);
    expect((await asUser(a)).length).toBe(2);
    // outlet_app cannot write the log or the templates
    await expect(asRole(env.client, "outlet_app", async (tx) => {
      await applyDbContext(tx, { kind: "user", marketId: "EG", userId: a });
      await tx.query("UPDATE notification_log SET status = 'sent'");
    })).rejects.toThrow(/permission denied/);
    await expect(asRole(env.client, "outlet_app", (tx) => tx.query("UPDATE notification_templates SET body = 'x'"))).rejects.toThrow(/permission denied/);
    // a worker of another job sees nothing (no exception policy), the dispatch job scans only its market
    const scan = (job: "outbox.relay" | "notifications.dispatch", market: string) => asRole(env.client, "outlet_worker", async (tx) => {
      await applyDbContext(tx, { kind: "worker", job, marketId: market });
      return (await tx.query("SELECT 1 FROM notification_log")).rows.length;
    });
    expect(await scan("outbox.relay", "EG")).toBe(0);
    expect(await scan("notifications.dispatch", "XX")).toBe(0);
    expect(await scan("notifications.dispatch", "EG")).toBe(4);
  });

  it("exposes the kill-switch names to register", async () => {
    env = await setupEnv();
    expect(Object.values(CHANNEL_KILL_SWITCH_NAMES)).toEqual(["notifications.push.enabled", "notifications.in_app.enabled", "notifications.whatsapp.enabled", "notifications.sms.enabled", "notifications.email.enabled"]);
    expect(NOON).toBeGreaterThan(0);
  });
});

describe("cancellation notices", () => {
  const sellerCancelled = (shopper: string, store: string, initiator = "shopper") =>
    event("seller_order.cancelled", shopper, { store_id: store, seller_order_id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", order_group_id: uuidv7(), reason_code: "changed_mind", initiator });

  it("notifies active owner, manager and warehouse members of the store in Arabic, nobody else", async () => {
    env = await setupEnv();
    const shopper = await insertUser(env.client);
    const [owner, manager, warehouse, finance, removed, en] = [await insertUser(env.client), await insertUser(env.client), await insertUser(env.client), await insertUser(env.client), await insertUser(env.client), await insertUser(env.client, "en-EG")];
    const store = await insertStore(env.client);
    const other = await insertStore(env.client);
    const otherOwner = await insertUser(env.client);
    await insertMember(env.client, store, owner, "owner");
    await insertMember(env.client, store, manager, "manager");
    await insertMember(env.client, store, warehouse, "warehouse");
    await insertMember(env.client, store, en, "manager");
    await insertMember(env.client, store, finance, "finance");
    await insertMember(env.client, store, removed, "owner", "removed");
    await insertMember(env.client, other, otherOwner, "owner");
    const d = env.dispatcher();
    const ev = sellerCancelled(shopper, store);
    expect(await d.handle(ev)).toBe("processed");
    expect(await d.runDue("EG", 100)).toBe(8); // four members x (in_app + push)
    for (const u of [owner, manager, warehouse, en]) expect((await logRows(env.client, u)).map((r) => r.channel)).toEqual(["in_app", "push"]);
    for (const u of [shopper, finance, removed, otherOwner]) expect(await logRows(env.client, u)).toHaveLength(0);
    const ar = env.fakes.push.sent.find((m) => m.userId === owner);
    expect(ar?.locale).toBe("ar-EG");
    expect(ar?.title).toBe("العميل لغى الطلب");
    expect(ar?.body).toContain("0190A1B2");
    expect(ar?.body).not.toMatch(/\{|\}|seller_order_cancelled_by_shopper|changed_mind|ج\.م|EGP/);
    const enMsg = env.fakes.push.sent.find((m) => m.userId === en);
    expect(enMsg?.locale).toBe("en-EG");
    expect(enMsg?.body).toContain("0190A1B2");
    // replay (same event, then a fresh inbox via the same event id) adds nothing
    expect(await d.handle(ev)).toBe("duplicate");
    expect(await d.runDue("EG", 100)).toBe(0);
  });

  it("is quiet when the seller cancelled, with no initiator, with no members, or with a malformed store id", async () => {
    env = await setupEnv();
    const shopper = await insertUser(env.client);
    const store = await insertStore(env.client);
    const d = env.dispatcher();
    expect(await d.handle(sellerCancelled(shopper, store, "seller"))).toBe("ignored");
    expect(await d.handle(event("seller_order.cancelled", shopper, { store_id: store }))).toBe("ignored");
    expect(await d.handle(sellerCancelled(shopper, store))).toBe("unresolved"); // no members
    expect(await d.handle(sellerCancelled(shopper, "not-a-uuid"))).toBe("unresolved");
    expect(await d.runDue("EG", 100)).toBe(0);
  });

  it("respects a member's transactional preference for a channel", async () => {
    env = await setupEnv();
    const shopper = await insertUser(env.client);
    const owner = await insertUser(env.client);
    const store = await insertStore(env.client);
    await insertMember(env.client, store, owner, "owner");
    await env.client.query("INSERT INTO notification_preferences (user_id, channel, category, market_id, enabled) VALUES ($1,'push','transactional','EG',false)", [owner]);
    const d = env.dispatcher();
    await d.handle(sellerCancelled(shopper, store));
    await d.runDue("EG", 100);
    expect(env.fakes.push.sent.filter((m) => m.userId === owner)).toHaveLength(0);
    const rows = await logRows(env.client, owner);
    expect(rows.some((r) => r.channel === "push" && r.status === "sent")).toBe(false);
    expect(rows.find((r) => r.channel === "in_app")?.status).toBe("sent"); // the inbox copy is unaffected
  });

  it("tells the shopper, with the store name and no amount, when a seller rejects an order", async () => {
    env = await setupEnv();
    const shopper = await insertUser(env.client);
    const store = await insertStore(env.client, { ar: "متجر النيل", en: "Nile Store" });
    const d = env.dispatcher();
    const ev = event("seller_order.rejected", shopper, { store_id: store, seller_order_id: uuidv7(), order_group_id: uuidv7(), reason_code: "out_of_stock", total_minor: "250000", currency: "EGP" });
    expect(await d.handle(ev)).toBe("processed");
    expect(await d.runDue("EG", 100)).toBe(2);
    const msg = env.fakes.push.sent[0];
    expect(msg?.title).toBe("اتلغت حاجات من طلبك");
    expect(msg?.body).toContain("متجر النيل");
    expect(msg?.body).toContain("المعاد القانوني");
    expect(msg?.body).not.toMatch(/\{|\}|order_item_cancelled_by_seller|ج\.م|out_of_stock/);
    expect(await d.handle(ev)).toBe("duplicate");
    expect(await d.runDue("EG", 100)).toBe(0);
  });

  it("uses the English store name for an English shopper and falls back when the store is unknown", async () => {
    env = await setupEnv();
    const en = await insertUser(env.client, "en-EG");
    const ar = await insertUser(env.client);
    const store = await insertStore(env.client, { ar: "متجر النيل", en: "Nile Store" });
    const d = env.dispatcher();
    await d.handle(event("seller_order.rejected", en, { store_id: store }));
    await d.handle(event("seller_order.rejected", ar, { store_id: uuidv7() }));
    await d.handle(event("seller_order.rejected", ar, {}));
    await d.runDue("EG", 100);
    expect(env.fakes.push.sent.find((m) => m.userId === en)?.body).toContain("Nile Store");
    expect(env.fakes.push.sent.filter((m) => m.userId === ar).every((m) => m.body.startsWith("المتجر"))).toBe(true);
  });
});
