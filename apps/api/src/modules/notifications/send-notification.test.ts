import { beforeEach, describe, expect, it } from "vitest";
import type { ProviderMessage } from "./domain/ports";
import { buildRig, cairo, U1, U2, type Rig } from "./test/support";

const DAY = "2027-01-15"; // a Friday in winter time (UTC+2)
const noon = (d = DAY): number => cairo(d, 12);
const TOKEN = "ExponentPushToken[secret-token-1]";
const INSTALL = "0192f3a4-5b6c-4d8e-9f01-23456789abcd";

let r: Rig;
beforeEach(async () => {
  r = await buildRig(noon());
});

const addToken = (userId = U1, token = TOKEN, installId = INSTALL) =>
  r.registerToken.execute(userId, { installId, platform: "ios", token });

describe("transactional delivery", () => {
  it("sends order_shipped by push, mirrors it into the inbox and logs the attempt", async () => {
    await addToken();
    const res = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "ord-1", payload: { order_no: "A100" }, deepLink: "/orders/ord-1" });
    expect(res).toMatchObject({ kind: "accepted", status: "SENT", channel: "push", inbox: true });
    expect(r.push.sent).toHaveLength(1);
    expect(r.push.sent[0]?.body).toBe("تم شحن طلبك رقم A100.");
    const inbox = r.inbox.all();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ userId: U1, bodyAr: "تم شحن طلبك رقم A100.", deepLink: "/orders/ord-1" });
    expect(r.log.all().map((l) => [l.channel, l.status, l.providerCode])).toEqual([
      ["in_app", "DELIVERED", "inbox"],
      ["push", "SENT", "expo_push"],
    ]);
    expect(r.events.events).toEqual([{ type: "notification.sent", requestId: expect.any(String), category: "transactional", channel: "push" }]);
  });

  it("renders English for an English-locale recipient", async () => {
    r.contacts.set(U2, { locale: "en", phone: "+201001230002", email: null });
    await r.registerToken.execute(U2, { installId: INSTALL, platform: "ios", token: TOKEN });
    await r.sender.execute({ userId: U2, templateKey: "order_shipped", ref: "o", payload: { order_no: "B7" } });
    expect(r.push.sent[0]?.body).toBe("Your order B7 has shipped.");
  });

  it("is exempt from quiet hours, consent and caps", async () => {
    await addToken();
    r.clock.set(cairo(DAY, 23, 30));
    const res = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "ord-night", payload: { order_no: "A1" } });
    expect(res).toMatchObject({ status: "SENT", channel: "push" });
    expect(r.push.sent).toHaveLength(1);
  });

  it("falls back to the phone channels when the user has no push token", async () => {
    const res = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "o2", payload: { order_no: "A2" } });
    expect(res).toMatchObject({ status: "SENT", channel: "whatsapp" });
    expect(r.wa.sent).toHaveLength(1);
  });

  it("sends security messages to one channel, never to the inbox", async () => {
    const res = await r.sender.execute({ userId: U1, templateKey: "otp_code", ref: "otp-1", payload: { code: "123456" } });
    expect(res).toMatchObject({ status: "SENT", channel: "sms", inbox: false });
    expect(r.inbox.all()).toHaveLength(0);
  });
});

describe("idempotency per (user, template, ref)", () => {
  it("returns the earlier request and sends once", async () => {
    await addToken();
    const a = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "same", payload: { order_no: "1" } });
    const b = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "same", payload: { order_no: "1" } });
    expect(b).toMatchObject({ kind: "duplicate", status: "SENT" });
    expect(a.kind === "accepted" && b.kind === "duplicate" && b.requestId === a.requestId).toBe(true);
    expect(r.push.sent).toHaveLength(1);
    expect(r.inbox.all()).toHaveLength(1);
  });

  it("collapses concurrent identical requests", async () => {
    await addToken();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "race", payload: { order_no: "1" } })),
    );
    expect(results.filter((x) => x.kind === "accepted")).toHaveLength(1);
    expect(r.push.sent).toHaveLength(1);
  });

  it("treats a different ref or user as a new notification", async () => {
    await addToken();
    await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "a", payload: { order_no: "1" } });
    await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "b", payload: { order_no: "1" } });
    expect(r.push.sent).toHaveLength(2);
  });
});

describe("input validation", () => {
  it("rejects unknown templates, bad payloads, bad refs, unsafe links and unknown recipients", async () => {
    await addToken();
    const ok = { userId: U1, templateKey: "order_shipped", ref: "x", payload: { order_no: "1" } };
    expect(await r.sender.execute({ ...ok, templateKey: "nope" })).toEqual({ kind: "rejected", reason: "unknown_template" });
    expect(await r.sender.execute({ ...ok, payload: {} })).toEqual({ kind: "rejected", reason: "invalid_payload" });
    expect(await r.sender.execute({ ...ok, payload: { order_no: "1", secret_dob: "1990" } })).toEqual({ kind: "rejected", reason: "invalid_payload" });
    expect(await r.sender.execute({ ...ok, ref: "has space" })).toEqual({ kind: "rejected", reason: "invalid_input" });
    expect(await r.sender.execute({ ...ok, deepLink: "https://evil.example" })).toEqual({ kind: "rejected", reason: "invalid_input" });
    expect(await r.sender.execute({ ...ok, expiresAtMs: r.clock.nowMs() - 1 })).toEqual({ kind: "rejected", reason: "invalid_input" });
    expect(await r.sender.execute({ ...ok, userId: "33333333-3333-4333-8333-333333333333" })).toEqual({ kind: "rejected", reason: "recipient_unknown" });
    expect(r.requests.all()).toHaveLength(0);
  });
});

describe("marketing consent gating", () => {
  beforeEach(async () => {
    await addToken();
  });

  it("never sends marketing push without consent; the inbox still gets it", async () => {
    const res = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "d1", payload: {} });
    expect(res).toMatchObject({ kind: "accepted", status: "SENT", channel: "in_app", inbox: true });
    expect(res.kind === "accepted" && res.reasons).toEqual(["NO_CONSENT", "NO_CONSENT"]);
    expect(r.push.sent).toHaveLength(0);
    expect(r.wa.sent).toHaveLength(0);
    expect(r.inbox.all()).toHaveLength(1);
  });

  it("sends with the channel's consent, and uses another consented channel when push is not", async () => {
    r.consent.grant(U1, "marketing_push");
    expect(await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "d2", payload: {} })).toMatchObject({ channel: "push" });
    r.consent.grant(U1, "marketing_whatsapp");
    r.consent.grant(U2, "marketing_whatsapp");
    await r.registerToken.execute(U2, { installId: INSTALL, platform: "ios", token: "other-token-123" });
    const viaWa = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "d3", payload: {} });
    // push is capped now (1 per day), whatsapp is consented: delivered there.
    expect(viaWa).toMatchObject({ status: "SENT", channel: "whatsapp", reasons: ["FREQUENCY_CAP"] });
  });

  it("does not send when the user switched the type off, and writes no inbox row", async () => {
    r.consent.grant(U1, "marketing_push");
    const view = await r.prefs.get(U1);
    expect(view.types.find((t) => t.type === "PROMOTIONS")?.enabled).toBe(true);
    await r.prefs.update(U1, { types: [{ type: "PROMOTIONS", enabled: false }] }, () => true);
    const res = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "d4", payload: {} });
    expect(res).toMatchObject({ status: "SUPPRESSED", suppressedReason: "PREFERENCE", inbox: false });
    expect(r.inbox.all()).toHaveLength(0);
    expect(r.push.sent).toHaveLength(0);
    expect(r.events.events.at(-1)).toMatchObject({ type: "notification.suppressed", reason: "PREFERENCE" });
  });

  it("honours a per-channel preference override", async () => {
    r.consent.grant(U1, "marketing_push");
    await r.prefs.update(U1, { types: [{ type: "PROMOTIONS.push", enabled: false }] }, () => true);
    const res = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "d5", payload: {} });
    expect(res).toMatchObject({ status: "SENT", channel: "in_app" });
    expect(r.push.sent).toHaveLength(0);
  });

  it("one-tap unsubscribe stops sending immediately even if consent is later restored without the event", async () => {
    r.consent.grant(U1, "marketing_push");
    const upd = await r.prefs.update(U1, { pushMarketing: false }, () => true);
    expect(upd.kind).toBe("updated");
    expect(await r.consent.isGranted(U1, "marketing_push")).toBe(false);
    r.consent.grant(U1, "marketing_push"); // re-granted elsewhere, event not yet processed
    const res = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "u1", payload: {} });
    expect(r.push.sent).toHaveLength(0);
    expect(res).toMatchObject({ channel: "in_app" });
    // The consent.changed event lifts the suppression.
    await r.handler.execute({
      messageId: "0192f3a4-5b6c-7d8e-9f01-000000000001",
      type: "consent.changed",
      payload: { user_id: U1, purpose: "marketing_push", granted: true },
    });
    const after = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "u2", payload: {} });
    expect(after).toMatchObject({ channel: "push" });
  });
});

describe("frequency caps (Cairo days)", () => {
  beforeEach(async () => {
    await addToken();
    r.consent.grant(U1, "marketing_push");
  });

  it("allows 1 per day and 3 per rolling 7 days", async () => {
    const send = async (day: string, ref: string) => {
      r.clock.set(noon(day));
      return r.sender.execute({ userId: U1, templateKey: "promo_drop", ref, payload: {} });
    };
    expect(await send("2027-01-15", "a")).toMatchObject({ channel: "push" });
    expect(await send("2027-01-15", "b")).toMatchObject({ channel: "in_app", reasons: expect.arrayContaining(["FREQUENCY_CAP"]) });
    expect(await send("2027-01-16", "c")).toMatchObject({ channel: "push" });
    expect(await send("2027-01-17", "d")).toMatchObject({ channel: "push" });
    expect(await send("2027-01-18", "e")).toMatchObject({ channel: "in_app", reasons: expect.arrayContaining(["FREQUENCY_CAP"]) });
    // Day 22 is the first day the 15th falls out of the trailing 7 Cairo days? 16,17 still count; 15 is out from the 22nd.
    expect(await send("2027-01-22", "f")).toMatchObject({ channel: "push" });
    expect(r.push.sent).toHaveLength(4);
  });

  it("a deferred or suppressed message does not consume the cap", async () => {
    r.clock.set(cairo(DAY, 23, 30));
    await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "q", payload: {} });
    r.clock.set(cairo("2027-01-16", 9, 0));
    const out = await r.due.execute();
    expect(out).toMatchObject({ processed: 1, sent: 1 });
    expect(r.push.sent).toHaveLength(1);
  });
});

describe("quiet hours", () => {
  beforeEach(async () => {
    await addToken();
    r.consent.grant(U1, "marketing_push");
  });

  it("defers marketing at 23:30 to 09:00 while transactional goes out immediately", async () => {
    r.clock.set(cairo(DAY, 23, 30));
    const promo = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "n1", payload: {} });
    const shipped = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "n2", payload: { order_no: "9" } });
    expect(promo).toMatchObject({ status: "SCHEDULED", channel: "push" });
    expect(r.requests.get((promo as { requestId: string }).requestId)?.scheduledForMs).toBe(cairo("2027-01-16", 9, 0));
    expect(shipped).toMatchObject({ status: "SENT" });
    expect(r.push.sent.map((m) => m.body)).toEqual(["تم شحن طلبك رقم 9."]);

    r.clock.set(cairo("2027-01-16", 8, 59));
    expect(await r.due.execute()).toMatchObject({ processed: 0 });
    r.clock.set(cairo("2027-01-16", 9, 0));
    expect(await r.due.execute()).toMatchObject({ processed: 1, sent: 1 });
    expect(r.push.sent).toHaveLength(2);
    // The released message is not sent twice.
    expect(await r.due.execute()).toMatchObject({ processed: 0 });
  });

  it("re-checks consent at release", async () => {
    r.clock.set(cairo(DAY, 23, 30));
    const promo = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "n3", payload: {} });
    await r.consent.withdraw(U1, "marketing_push");
    r.clock.set(cairo("2027-01-16", 9, 1));
    await r.due.execute();
    expect(r.push.sent).toHaveLength(0);
    expect(r.requests.get((promo as { requestId: string }).requestId)).toMatchObject({ status: "SUPPRESSED", suppressedReason: "NO_CONSENT" });
  });

  it("drops (never delays) a message that would expire before 09:00", async () => {
    r.clock.set(cairo(DAY, 23, 30));
    const res = await r.sender.execute({
      userId: U1, templateKey: "promo_drop", ref: "flash", payload: {}, expiresAtMs: cairo(DAY, 23, 30) + 3_600_000,
    });
    expect(res).toMatchObject({ channel: "in_app", reasons: expect.arrayContaining(["QUIET_HOURS"]) });
    r.clock.set(cairo("2027-01-16", 9, 0));
    expect(await r.due.execute()).toMatchObject({ processed: 0 });
    expect(r.push.sent).toHaveLength(0);
  });

  it("cancels a queued message when the recipient is gone", async () => {
    r.clock.set(cairo(DAY, 23, 30));
    const promo = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "gone", payload: {} });
    r.contacts.remove(U1);
    r.clock.set(cairo("2027-01-16", 9, 0));
    await r.due.execute();
    expect(r.requests.get((promo as { requestId: string }).requestId)?.status).toBe("CANCELLED");
  });
});

describe("provider failover", () => {
  it("tries the next provider when the first is unavailable", async () => {
    r.smsPrimary.enqueue({ kind: "unavailable" });
    const res = await r.sender.execute({ userId: U1, templateKey: "otp_code", ref: "o1", payload: { code: "111111" } });
    expect(res).toMatchObject({ status: "SENT", channel: "sms" });
    expect(r.smsBackup.sent).toHaveLength(1);
    expect(r.log.all().map((l) => [l.providerCode, l.status, l.failureCode])).toEqual([
      ["sms_primary", "FAILED", "provider_unavailable"],
      ["sms_backup", "SENT", null],
    ]);
  });

  it("treats a throwing adapter as an outage", async () => {
    r.smsPrimary.send = async () => {
      throw new Error("socket hang up");
    };
    const res = await r.sender.execute({ userId: U1, templateKey: "otp_code", ref: "o2", payload: { code: "111111" } });
    expect(res).toMatchObject({ status: "SENT" });
    expect(r.smsBackup.sent).toHaveLength(1);
  });

  it("retries with backoff when every provider is down, then succeeds", async () => {
    r.smsPrimary.setDefault({ kind: "unavailable" });
    r.smsBackup.setDefault({ kind: "unavailable" });
    const res = await r.sender.execute({ userId: U1, templateKey: "otp_code", ref: "o3", payload: { code: "1" } });
    expect(res).toMatchObject({ status: "SCHEDULED", channel: "sms" });
    const id = (res as { requestId: string }).requestId;
    const first = r.requests.get(id);
    expect(first?.attempts).toBe(1);
    expect(first?.scheduledForMs).toBeGreaterThan(r.clock.nowMs());
    // Not yet due.
    expect(await r.due.execute()).toMatchObject({ processed: 0 });
    // Provider recovers.
    r.smsPrimary.setDefault(null);
    r.clock.set(first?.scheduledForMs ?? 0);
    expect(await r.due.execute()).toMatchObject({ processed: 1, sent: 1 });
    expect(r.requests.get(id)).toMatchObject({ status: "SENT", attempts: 2 });
  });

  it("gives up as FAILED at the message TTL and emits notification.failed", async () => {
    r.smsPrimary.setDefault({ kind: "unavailable" });
    r.smsBackup.setDefault({ kind: "unavailable" });
    const res = await r.sender.execute({
      userId: U1, templateKey: "otp_code", ref: "o4", payload: { code: "1" }, expiresAtMs: r.clock.nowMs() + 5 * 60_000,
    });
    const id = (res as { requestId: string }).requestId;
    for (let i = 0; i < 20 && r.requests.get(id)?.status === "SCHEDULED"; i += 1) {
      r.clock.set(r.requests.get(id)?.scheduledForMs ?? r.clock.nowMs());
      await r.due.execute();
    }
    expect(r.requests.get(id)?.status).toBe("FAILED");
    expect(r.events.events.at(-1)).toMatchObject({ type: "notification.failed", code: "ttl_expired" });
  });
});

describe("WhatsApp template rejection", () => {
  it("falls back to SMS for a transactional message", async () => {
    r.wa.enqueue({ kind: "template_rejected" });
    const res = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "w1", payload: { order_no: "5" } });
    expect(res).toMatchObject({ status: "SENT", channel: "sms" });
    expect(r.smsPrimary.sent).toHaveLength(1);
    expect(r.log.all().map((l) => [l.channel, l.status, l.failureCode])).toContainEqual(["whatsapp", "FAILED", "template_rejected"]);
  });

  it("never falls back to SMS for marketing", async () => {
    r.consent.grant(U1, "marketing_whatsapp");
    r.wa.enqueue({ kind: "template_rejected" });
    const res = await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "w2", payload: {} });
    expect(res).toMatchObject({ status: "FAILED" });
    expect(r.smsPrimary.sent).toHaveLength(0);
    expect(r.smsBackup.sent).toHaveLength(0);
    expect(r.events.events.at(-1)).toMatchObject({ type: "notification.failed", code: "template_rejected" });
  });

  it("treats a template that is not APPROVED like a rejection without calling the provider", async () => {
    const t = (await r.templates.activeFor("order_shipped", r.clock.nowMs())).find((x) => x.channel === "whatsapp");
    if (t === undefined) throw new Error("seed missing");
    await r.templates.save({ ...t, approval: "SUBMITTED" });
    const res = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "w3", payload: { order_no: "6" } });
    expect(res).toMatchObject({ status: "SENT", channel: "sms" });
    expect(r.wa.sent).toHaveLength(0);
  });
});

describe("invalid device tokens", () => {
  it("deactivates the token, suppresses push when none is left and keeps the inbox row", async () => {
    await addToken();
    r.push.enqueue({ kind: "invalid_recipient" });
    const res = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "t1", payload: { order_no: "1" } });
    expect(res).toMatchObject({ status: "FAILED", inbox: true });
    expect(await r.tokens.active(U1)).toHaveLength(0);
    expect((await r.suppressions.active(U1, "push")).has("INVALID_TOKEN")).toBe(true);
    expect(r.inbox.all()).toHaveLength(1);
    // The next message skips push and goes to the phone channels.
    const next = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "t2", payload: { order_no: "2" } });
    expect(next).toMatchObject({ status: "SENT", channel: "whatsapp" });
  });

  it("keeps working tokens when only one of several is invalid", async () => {
    await addToken(U1, "token-aaaaaaaa", "0192f3a4-5b6c-4d8e-9f01-000000000001");
    await addToken(U1, "token-bbbbbbbb", "0192f3a4-5b6c-4d8e-9f01-000000000002");
    r.push.enqueue({ kind: "invalid_recipient" });
    const res = await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "t3", payload: { order_no: "3" } });
    expect(res).toMatchObject({ status: "SENT", channel: "push" });
    expect(await r.tokens.active(U1)).toHaveLength(1);
  });
});

describe("no PII in logs, events or analytics", () => {
  it("keeps tokens, phones and emails out of every stored record", async () => {
    await addToken();
    r.consent.grant(U1, "marketing_push");
    await r.sender.execute({ userId: U1, templateKey: "order_shipped", ref: "p1", payload: { order_no: "A9" } });
    await r.sender.execute({ userId: U1, templateKey: "wishlist_price_drop", ref: "p2", payload: {} });
    const dump = JSON.stringify([r.log.all(), r.events.events, r.analytics.events]);
    for (const secret of [TOKEN, "+201001230001", "u1@example.invalid"]) expect(dump).not.toContain(secret);
  });

  it("sends the wishlist_alert_sent analytics event with only alert_type and channel", async () => {
    await addToken();
    r.consent.grant(U1, "marketing_push");
    await r.sender.execute({ userId: U1, templateKey: "wishlist_price_drop", ref: "a1", payload: {} });
    expect(r.analytics.events).toEqual([{ name: "wishlist_alert_sent", properties: { alert_type: "price_drop", channel: "push" } }]);
  });
});

describe("queued messages keep their template version", () => {
  it("renders a released message with the version it was accepted with", async () => {
    await addToken();
    r.consent.grant(U1, "marketing_push");
    r.clock.set(cairo(DAY, 23, 30));
    await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "v1", payload: {} });
    const push = (await r.templates.activeFor("promo_drop", r.clock.nowMs())).find((t) => t.channel === "push");
    if (push === undefined) throw new Error("seed missing");
    await r.templates.save({ ...push, id: "v2", version: 2, bodyAr: "نص جديد", bodyEn: "New text" });
    r.clock.set(cairo("2027-01-16", 9, 0));
    await r.due.execute();
    const sent = r.push.sent[0] as ProviderMessage;
    expect(sent.body).toBe("وصلت مجموعة جديدة من متاجرك المفضلة.");
    // A request created now uses version 2.
    r.clock.set(cairo("2027-01-18", 12, 0));
    await r.sender.execute({ userId: U1, templateKey: "promo_drop", ref: "v2", payload: {} });
    expect(r.push.sent.at(-1)?.body).toBe("نص جديد");
  });
});

describe("outbox event consumer", () => {
  const MSG = "0192f3a4-5b6c-7d8e-9f01-0000000000a1";

  it("sends once however many times the same outbox message is delivered", async () => {
    await addToken();
    const ev = { messageId: MSG, type: "order_group.paid", payload: { order_group_id: "og-1", user_id: U1, total_minor: 1000 } };
    const first = await r.handler.execute(ev);
    const second = await r.handler.execute(ev);
    expect(first).toMatchObject({ kind: "processed" });
    expect(second).toEqual({ kind: "duplicate" });
    expect(r.push.sent).toHaveLength(1);
    expect(r.inbox.all()).toHaveLength(1);
  });

  it("is also idempotent across distinct messages for the same business reference", async () => {
    await addToken();
    const p = { order_group_id: "og-2", user_id: U1 };
    await r.handler.execute({ messageId: "0192f3a4-5b6c-7d8e-9f01-0000000000a2", type: "order_group.paid", payload: p });
    const again = await r.handler.execute({ messageId: "0192f3a4-5b6c-7d8e-9f01-0000000000a3", type: "order_group.paid", payload: p });
    expect(again).toMatchObject({ kind: "processed", send: { kind: "duplicate" } });
    expect(r.push.sent).toHaveLength(1);
  });

  it("rolls the mark back when handling throws so the message is redelivered", async () => {
    await addToken();
    let calls = 0;
    const original = r.contacts.contact.bind(r.contacts);
    r.contacts.contact = async (id: string) => {
      calls += 1;
      if (calls === 1) throw new Error("db down");
      return original(id);
    };
    const ev = { messageId: MSG, type: "refund.completed", payload: { refund_id: "rf-1", user_id: U1 } };
    await expect(r.handler.execute(ev)).rejects.toThrow("db down");
    expect(await r.handler.execute(ev)).toMatchObject({ kind: "processed" });
    expect(r.push.sent).toHaveLength(1);
  });

  it("maps wishlist alerts, ignores unknown types and flags invalid payloads", async () => {
    await addToken();
    r.consent.grant(U1, "marketing_push");
    const alert = { alertType: "price_drop_verified", wishlistId: "wl-1", userId: U1, dedupeKey: "price_drop:i1:c1" };
    const res = await r.handler.execute({ messageId: MSG, type: "wishlist.alert_due", payload: { alert } });
    expect(res).toMatchObject({ kind: "processed", send: { kind: "accepted", channel: "push" } });
    expect(r.inbox.all()[0]?.deepLink).toBe("/wishlists/wl-1");
    expect(await r.handler.execute({ messageId: "0192f3a4-5b6c-7d8e-9f01-0000000000a9", type: "cart.line_unavailable", payload: {} })).toEqual({ kind: "ignored" });
    expect(await r.handler.execute({ messageId: "0192f3a4-5b6c-7d8e-9f01-0000000000aa", type: "refund.completed", payload: { nope: 1 } })).toEqual({ kind: "invalid" });
    expect(await r.handler.execute({ messageId: "not-a-uuid", type: "refund.completed", payload: {} })).toEqual({ kind: "invalid" });
  });
});

describe("preferences service rules", () => {
  it("rejects consent-less opt in, SMS marketing, fixed types and unknown types, applying nothing", async () => {
    const before = await r.prefs.get(U1);
    expect(await r.prefs.update(U1, { pushMarketing: true }, () => true)).toEqual({ kind: "rule", code: "consent_required" });
    expect(await r.prefs.update(U1, { smsMarketing: true }, () => true)).toEqual({ kind: "rule", code: "channel_not_supported" });
    expect(await r.prefs.update(U1, { types: [{ type: "ORDER_UPDATES", enabled: false }] }, () => true)).toEqual({ kind: "rule", code: "type_not_switchable" });
    expect(await r.prefs.update(U1, { types: [{ type: "NOPE", enabled: false }] }, () => true)).toEqual({ kind: "rule", code: "unknown_type" });
    expect(await r.prefs.update(U1, { types: [{ type: "PROMOTIONS.sms", enabled: true }] }, () => true)).toEqual({ kind: "rule", code: "channel_not_supported" });
    expect(
      await r.prefs.update(U1, { emailMarketing: false, types: [{ type: "PROMOTIONS", enabled: false }, { type: "ORDER_UPDATES", enabled: false }] }, () => true),
    ).toEqual({ kind: "rule", code: "type_not_switchable" });
    expect(await r.prefs.get(U1)).toEqual(before);
  });

  it("reports the precondition result without applying", async () => {
    expect(await r.prefs.update(U1, { types: [{ type: "PLUS", enabled: false }] }, () => false)).toEqual({ kind: "precondition_failed" });
    expect((await r.prefs.get(U1)).types.find((t) => t.type === "PLUS")?.enabled).toBe(true);
  });

  it("mirrors consent in the marketing flags and always reports SMS marketing off", async () => {
    r.consent.grant(U1, "marketing_email");
    const v = await r.prefs.get(U1);
    expect([v.pushMarketing, v.whatsappMarketing, v.emailMarketing, v.smsMarketing]).toEqual([false, false, true, false]);
    expect(v.quietHours).toEqual({ from: "23:00", to: "09:00", timezone: "Africa/Cairo" });
  });
});
