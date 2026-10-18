import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { OtpSender, OtpSendRequest, OtpSendResult } from "@outlet/auth-core";
import type { ProviderMessage } from "../../../modules/notifications";
import { EXTERNAL_CHANNELS } from "../../../modules/notifications/domain/types";
import { providerStatus, resetBoundUnconfigured } from "../../unconfigured";
import { channelConformanceCases, FakeFetch, jsonRes, testHttp } from "./conformance";
import { parseCommsConfig } from "./config";
import { maskEmail, maskPhone, maskToken, safeEqual } from "./core";
import { handleEmailWebhook, PostmarkEmailProvider, verifyEmailWebhookSecret } from "./email";
import { EXPO_MAX_BATCH, ExpoPushProvider, InMemoryPushTicketStore } from "./expo-push";
import { FailoverOtpSender } from "./failover";
import { buildCommsWiring, COMMS_BINDINGS } from "./select";
import { parseSmsStatus, SmsOtpSender, TwilioStyleSmsProvider, type TwilioStyleConfig, verifySmsStatusSignature } from "./sms";
import { parseWhatsAppStatuses, verifyWhatsAppSignature, WhatsAppCloudProvider, WhatsAppOtpSender } from "./whatsapp";

// ALL FIXTURES BELOW ARE HAND-AUTHORED from public vendor docs. VERIFY BEFORE LAUNCH against sandbox traffic.
const PHONE = "+201001234567";
const TOKEN = "ExponentPushToken[abcdefghijklmnop]";
const base = (channel: ProviderMessage["channel"], to: string): ProviderMessage => ({
  requestId: "req-1", channel, to, subject: "Order shipped", body: "SECRET-BODY-TEXT", providerTemplateId: null, locale: "en",
});
const clock = () => 1_000_000_000;

function run(cases: ReturnType<typeof channelConformanceCases>) {
  for (const c of cases) it(c.name, c.run);
}

const smsCfg: TwilioStyleConfig = { vendor: "sms_a", baseUrl: "https://sms.test", verifyBaseUrl: "https://verify.test", accountSid: "AC123", authToken: "SECRET-AUTH", from: "OUTLET", messagingServiceSid: undefined, verifyServiceSid: "VA1", statusCallbackUrl: undefined };
const mkSms = (http: ReturnType<typeof testHttp>, budget: { tryConsume(p: string, t: number): Promise<boolean> } | null = null, cfg = smsCfg) =>
  new TwilioStyleSmsProvider(cfg, { http, policy: { allowedPrefixes: ["+20"] }, budget, nowMs: clock });
const waCfg = { phoneNumberId: "555", accessToken: "SECRET-WA-TOKEN", appSecret: "wa-secret", otpTemplate: "otp_auth" };

describe("conformance: expo push", () => {
  run(channelConformanceCases({
    name: "expo", message: { ...base("push", TOKEN), channel: "push" },
    build: (http) => new ExpoPushProvider({ http, deactivator: { deactivateToken: async () => undefined }, tickets: new InMemoryPushTicketStore(), nowMs: clock }),
    responses: {
      ok: () => jsonRes(200, { data: [{ status: "ok", id: "ticket-1" }] }),
      serverError: () => jsonRes(503, "unavailable"),
      permanent: () => jsonRes(400, { errors: [{ code: "VALIDATION_ERROR" }] }),
      malformed: () => jsonRes(200, { data: "nope" }),
      invalidRecipient: () => jsonRes(200, { data: [{ status: "error", message: "x", details: { error: "DeviceNotRegistered" } }] }),
    },
    retriesServerError: false, secrets: [TOKEN, "SECRET-BODY-TEXT"],
  }));
});

describe("conformance: sms", () => {
  run(channelConformanceCases({
    name: "sms", message: { ...base("sms", PHONE), channel: "sms" }, build: (http) => mkSms(http),
    responses: {
      ok: () => jsonRes(201, { sid: "SM1", status: "queued" }),
      serverError: () => jsonRes(500, {}),
      permanent: () => jsonRes(400, { code: 21602, message: "Message body is required" }),
      malformed: () => jsonRes(201, { oops: true }),
      invalidRecipient: () => jsonRes(400, { code: 21211, message: "Invalid 'To' Phone Number" }),
    },
    retriesServerError: false, secrets: [PHONE, "SECRET-AUTH", "SECRET-BODY-TEXT"],
  }));
});

describe("conformance: whatsapp", () => {
  run(channelConformanceCases({
    name: "whatsapp", message: { ...base("whatsapp", PHONE), channel: "whatsapp", providerTemplateId: "order_update" },
    build: (http) => new WhatsAppCloudProvider(waCfg, http),
    responses: {
      ok: () => jsonRes(200, { messaging_product: "whatsapp", messages: [{ id: "wamid.1" }] }),
      serverError: () => jsonRes(500, {}),
      permanent: () => jsonRes(400, { error: { code: 100, message: "bad" } }),
      malformed: () => jsonRes(200, { messages: [] }),
      invalidRecipient: () => jsonRes(400, { error: { code: 131026 } }),
    },
    retriesServerError: false, secrets: [PHONE, "SECRET-WA-TOKEN", "SECRET-BODY-TEXT"],
  }));
});

describe("conformance: email", () => {
  run(channelConformanceCases({
    name: "email", message: { ...base("email", "user@example.com"), channel: "email" },
    build: (http) => new PostmarkEmailProvider({ serverToken: "SECRET-PM-TOKEN", from: "no-reply@outlet.test", messageStream: "outbound" }, http),
    responses: {
      ok: () => jsonRes(200, { ErrorCode: 0, Message: "OK", MessageID: "pm-1" }),
      serverError: () => jsonRes(500, {}),
      permanent: () => jsonRes(422, { ErrorCode: 100, Message: "Maintenance" }),
      malformed: () => jsonRes(200, { hello: "world" }),
      invalidRecipient: () => jsonRes(422, { ErrorCode: 406, Message: "Inactive recipient" }),
    },
    retriesServerError: false, secrets: ["user@example.com", "SECRET-PM-TOKEN", "SECRET-BODY-TEXT"],
  }));
});

describe("expo push specifics", () => {
  it("batches at most 100 per request and records tickets", async () => {
    const fake = new FakeFetch();
    const n = 250;
    let seq = 0;
    for (const size of [100, 100, 50]) fake.enqueue(jsonRes(200, { data: Array.from({ length: size }, () => ({ status: "ok", id: `t${seq++}` })) }));
    const tickets = new InMemoryPushTicketStore();
    const p = new ExpoPushProvider({ http: testHttp(fake), deactivator: { deactivateToken: async () => undefined }, tickets, nowMs: clock });
    const msgs = Array.from({ length: n }, (_, i) => ({ ...base("push", `ExponentPushToken[${i}]`), channel: "push" as const }));
    const out = await p.sendBatch(msgs);
    expect(out).toHaveLength(n);
    expect(fake.requests.map((r) => (JSON.parse(r.body) as unknown[]).length)).toEqual([EXPO_MAX_BATCH, EXPO_MAX_BATCH, 50]);
    expect(fake.requests[0]?.url).toBe("https://exp.host/--/api/v2/push/send");
    expect(tickets.size).toBe(n);
  });
  it("DeviceNotRegistered at ticket time deactivates the token", async () => {
    const dead: string[] = [];
    const fake = new FakeFetch().enqueue(jsonRes(200, { data: [{ status: "error", details: { error: "DeviceNotRegistered" } }] }));
    const p = new ExpoPushProvider({ http: testHttp(fake), deactivator: { deactivateToken: async (t) => void dead.push(t) }, tickets: new InMemoryPushTicketStore(), nowMs: clock });
    expect(await p.send({ ...base("push", TOKEN), channel: "push" })).toEqual({ kind: "invalid_recipient" });
    expect(dead).toEqual([TOKEN]);
  });
  it("receipt polling deactivates DeviceNotRegistered, keeps unready tickets, retries 5xx", async () => {
    const dead: string[] = [];
    const tickets = new InMemoryPushTicketStore();
    await tickets.record([{ ticketId: "a", token: "tokA" }, { ticketId: "b", token: "tokB" }, { ticketId: "c", token: "tokC" }], 0);
    const fake = new FakeFetch().enqueue(
      jsonRes(502, {}),
      jsonRes(200, { data: { a: { status: "ok" }, b: { status: "error", details: { error: "DeviceNotRegistered" } } } }),
    );
    const p = new ExpoPushProvider({ http: testHttp(fake), deactivator: { deactivateToken: async (t) => void dead.push(t) }, tickets, nowMs: () => 20 * 60_000 });
    expect(await p.pollReceipts()).toEqual({ checked: 3, deactivated: 1 });
    expect(dead).toEqual(["tokB"]);
    expect(tickets.size).toBe(1);
    expect(fake.requests).toHaveLength(2);
  });
  it("retries a 429 honouring Retry-After, then succeeds", async () => {
    const waits: number[] = [];
    const fake = new FakeFetch().enqueue(jsonRes(429, {}, { "retry-after": "2" }), jsonRes(200, { data: [{ status: "ok", id: "t" }] }));
    const http = { ...testHttp(fake), sleep: async (ms: number) => void waits.push(ms) };
    const p = new ExpoPushProvider({ http, deactivator: { deactivateToken: async () => undefined }, tickets: new InMemoryPushTicketStore(), nowMs: clock });
    expect((await p.send({ ...base("push", TOKEN), channel: "push" })).kind).toBe("sent");
    expect(waits).toEqual([2000]);
  });
});

describe("sms specifics", () => {
  it("rejects non-EG destinations BEFORE any request", async () => {
    const fake = new FakeFetch();
    const r = await mkSms(testHttp(fake)).send({ ...base("sms", "+14155550100"), channel: "sms" });
    expect(r).toEqual({ kind: "failed", code: "destination_not_allowed" });
    expect(fake.requests).toHaveLength(0);
  });
  it("rejects non E.164 input before any request", async () => {
    const fake = new FakeFetch();
    expect(await mkSms(testHttp(fake)).send({ ...base("sms", "01001234567"), channel: "sms" })).toEqual({ kind: "invalid_recipient" });
    expect(fake.requests).toHaveLength(0);
  });
  it("consults the per-prefix budget hook and stops when spent", async () => {
    const seen: string[] = [];
    const fake = new FakeFetch();
    const r = await mkSms(testHttp(fake), { tryConsume: async (p) => (seen.push(p), false) }).send({ ...base("sms", PHONE), channel: "sms" });
    expect(seen).toEqual(["+2010"]);
    expect(r).toEqual({ kind: "failed", code: "budget_exceeded" });
    expect(fake.requests).toHaveLength(0);
  });
  it("sends form fields, basic auth and the idempotency token", async () => {
    const fake = new FakeFetch().enqueue(jsonRes(201, { sid: "SM9", status: "queued" }));
    await mkSms(testHttp(fake)).send({ ...base("sms", PHONE), channel: "sms" });
    const rq = fake.requests[0];
    expect(rq?.url).toBe("https://sms.test/2010-04-01/Accounts/AC123/Messages.json");
    expect(rq?.headers["i-twilio-idempotency-token"]).toBe("req-1");
    expect(rq?.headers.authorization?.startsWith("Basic ")).toBe(true);
    expect(new URLSearchParams(rq?.body).get("From")).toBe("OUTLET");
  });
  it("uses a messaging service when configured", async () => {
    const fake = new FakeFetch().enqueue(jsonRes(201, { sid: "SM9", status: "queued" }));
    await mkSms(testHttp(fake), null, { ...smsCfg, from: undefined, messagingServiceSid: "MG1" }).send({ ...base("sms", PHONE), channel: "sms" });
    const form = new URLSearchParams(fake.requests[0]?.body);
    expect(form.get("MessagingServiceSid")).toBe("MG1");
    expect(form.has("From")).toBe(false);
  });
  it("verify start and check", async () => {
    const fake = new FakeFetch().enqueue(jsonRes(201, { sid: "VE1", status: "pending" }), jsonRes(200, { sid: "VE1", status: "approved" }), jsonRes(404, {}));
    const p = mkSms(testHttp(fake));
    expect(await p.startVerification(PHONE)).toBe("VE1");
    expect(await p.checkVerification(PHONE, "123456")).toBe(true);
    expect(await p.checkVerification(PHONE, "000000")).toBe(false);
  });
  it("OTP sender maps outcomes and never leaks the code in the reason", async () => {
    const req: OtpSendRequest = { phoneE164: PHONE, code: "482913", locale: "ar", idempotencyKey: "k1" };
    const fake = new FakeFetch().enqueue(jsonRes(201, { sid: "SM1", status: "queued" }), jsonRes(500, {}));
    const s = new SmsOtpSender(mkSms(testHttp(fake)));
    expect(await s.send(req)).toEqual({ ok: true, providerMessageId: "SM1" });
    expect(fake.requests[0]?.body).toContain(encodeURIComponent("482913"));
    const bad = await s.send(req);
    expect(bad).toEqual({ ok: false, retryable: true, reason: "provider_unavailable" });
    expect(await new SmsOtpSender(mkSms(testHttp(new FakeFetch()))).send({ ...req, phoneE164: "+971500000000" })).toEqual({ ok: false, retryable: false, reason: "rejected_destination_not_allowed" });
  });
});

describe("failover order", () => {
  const stub = (id: string, results: OtpSendResult[], calls: string[]): OtpSender => ({
    id, channel: "sms", send: async () => (calls.push(id), results.shift() ?? { ok: false, retryable: true, reason: "x" }),
  });
  const req: OtpSendRequest = { phoneE164: PHONE, code: "111111", locale: "en", idempotencyKey: "k" };
  it("A then B then WhatsApp, stops at first success", async () => {
    const calls: string[] = [];
    const f = new FailoverOtpSender([
      stub("A", [{ ok: false, retryable: true, reason: "provider_unavailable" }], calls),
      stub("B", [{ ok: false, retryable: false, reason: "provider_not_configured" }], calls),
      stub("WA", [{ ok: true, providerMessageId: "w1" }], calls),
    ]);
    expect(await f.send(req)).toEqual({ ok: true, providerMessageId: "w1" });
    expect(calls).toEqual(["A", "B", "WA"]);
  });
  it("stops on a permanent refusal and does not try later senders", async () => {
    const calls: string[] = [];
    const f = new FailoverOtpSender([stub("A", [{ ok: false, retryable: false, reason: "rejected_invalid_recipient" }], calls), stub("B", [], calls)]);
    expect((await f.send(req)).ok).toBe(false);
    expect(calls).toEqual(["A"]);
  });
  it("a throwing sender counts as retryable and the chain continues; all failing returns the last failure", async () => {
    const calls: string[] = [];
    const boom: OtpSender = { id: "boom", channel: "sms", send: async () => { calls.push("boom"); throw new Error("x"); } };
    const f = new FailoverOtpSender([boom, stub("B", [{ ok: false, retryable: true, reason: "provider_unavailable" }], calls)]);
    expect(await f.send(req)).toEqual({ ok: false, retryable: true, reason: "provider_unavailable" });
    expect(calls).toEqual(["boom", "B"]);
  });
  it("end to end: SMS A 5xx, SMS B 5xx, WhatsApp delivers", async () => {
    const fa = new FakeFetch().enqueue(jsonRes(500, {}));
    const fb = new FakeFetch().enqueue(jsonRes(500, {}));
    const fw = new FakeFetch().enqueue(jsonRes(200, { messages: [{ id: "wamid.OTP" }] }));
    const f = new FailoverOtpSender([
      new SmsOtpSender(mkSms(testHttp(fa))),
      new SmsOtpSender(mkSms(testHttp(fb), null, { ...smsCfg, vendor: "sms_b" })),
      new WhatsAppOtpSender(new WhatsAppCloudProvider(waCfg, testHttp(fw)), "otp_auth"),
    ]);
    expect(await f.send(req)).toEqual({ ok: true, providerMessageId: "wamid.OTP" });
    const sent = JSON.parse(fw.requests[0]?.body ?? "{}") as { template: { name: string; language: { code: string } } };
    expect(sent.template.name).toBe("otp_auth");
    expect(sent.template.language.code).toBe("en");
  });
});

describe("whatsapp specifics", () => {
  it("refuses a free-text send (no template) without a request", async () => {
    const fake = new FakeFetch();
    const p = new WhatsAppCloudProvider(waCfg, testHttp(fake));
    expect(await p.send({ ...base("whatsapp", PHONE), channel: "whatsapp" })).toEqual({ kind: "template_rejected" });
    expect(fake.requests).toHaveLength(0);
  });
  it("sends template name, AR language and variables; maps 132001 to template_rejected", async () => {
    const fake = new FakeFetch().enqueue(jsonRes(200, { messages: [{ id: "w" }] }), jsonRes(404, { error: { code: 132001 } }));
    const p = new WhatsAppCloudProvider(waCfg, testHttp(fake));
    const m = { ...base("whatsapp", PHONE), channel: "whatsapp" as const, providerTemplateId: "order_update", locale: "ar" as const };
    expect((await p.send(m)).kind).toBe("sent");
    const body = JSON.parse(fake.requests[0]?.body ?? "{}") as { to: string; template: { name: string; language: { code: string }; components: { parameters: { text: string }[] }[] } };
    expect(body.to).toBe("201001234567");
    expect(body.template.language.code).toBe("ar");
    expect(body.template.components[0]?.parameters[0]?.text).toBe("SECRET-BODY-TEXT");
    expect(await p.send(m)).toEqual({ kind: "template_rejected" });
  });
  it("webhook signature is verified over the raw body", () => {
    const raw = JSON.stringify({ entry: [] });
    const sig = `sha256=${createHmac("sha256", "wa-secret").update(raw).digest("hex")}`;
    expect(verifyWhatsAppSignature("wa-secret", raw, sig)).toBe(true);
    expect(verifyWhatsAppSignature("wa-secret", `${raw} `, sig)).toBe(false);
    expect(verifyWhatsAppSignature("wa-secret", raw, undefined)).toBe(false);
    expect(verifyWhatsAppSignature("wa-secret", raw, "sha256=abc")).toBe(false);
  });
  it("parses statuses and returns null on drift", () => {
    const body = { entry: [{ changes: [{ value: { statuses: [{ id: "w1", status: "failed", errors: [{ code: 131026 }] }, { id: "w2", status: "delivered" }] } }] }] };
    expect(parseWhatsAppStatuses(body)).toEqual([
      { providerRef: "w1", status: "failed", errorCode: 131026 },
      { providerRef: "w2", status: "delivered", errorCode: null },
    ]);
    expect(parseWhatsAppStatuses({ entry: "x" })).toBeNull();
  });
});

describe("sms webhook", () => {
  it("verifies a Twilio-style HMAC-SHA1 signature in constant time and rejects tampering", () => {
    const url = "https://api.test/v1/webhooks/sms";
    const params = { MessageSid: "SM1", MessageStatus: "delivered" };
    const sig = createHmac("sha1", "tok").update(`${url}MessageSidSM1MessageStatusdelivered`).digest("base64");
    expect(verifySmsStatusSignature("tok", url, params, sig)).toBe(true);
    expect(verifySmsStatusSignature("tok", url, { ...params, MessageStatus: "failed" }, sig)).toBe(false);
    expect(verifySmsStatusSignature("tok", url, params, undefined)).toBe(false);
    expect(parseSmsStatus({ MessageSid: "SM1", MessageStatus: "undelivered", ErrorCode: "30005" })).toEqual({ providerRef: "SM1", status: "undelivered", errorCode: "30005" });
    expect(parseSmsStatus({ nope: "1" })).toBeNull();
  });
});

describe("email webhook", () => {
  const rec: { a: string; r: string }[] = [];
  const sink = { suppress: async (a: string, r: string) => void rec.push({ a, r }) };
  beforeEach(() => void (rec.length = 0));
  it("records hard bounce, complaint and unsubscribe; ignores transient", async () => {
    expect(await handleEmailWebhook({ RecordType: "Bounce", Type: "HardBounce", Email: "a@x.test" }, sink, 1)).toEqual({ recorded: "BOUNCE" });
    expect(await handleEmailWebhook({ RecordType: "Bounce", Type: "Transient", Email: "b@x.test" }, sink, 1)).toEqual({ recorded: null });
    expect(await handleEmailWebhook({ RecordType: "SpamComplaint", Email: "c@x.test" }, sink, 1)).toEqual({ recorded: "COMPLAINT" });
    expect(await handleEmailWebhook({ RecordType: "SubscriptionChange", Recipient: "d@x.test", SuppressSending: true }, sink, 1)).toEqual({ recorded: "UNSUBSCRIBED" });
    expect(rec.map((x) => x.r)).toEqual(["BOUNCE", "COMPLAINT", "UNSUBSCRIBED"]);
  });
  it("drift returns null and records nothing; secret check is exact", async () => {
    expect(await handleEmailWebhook({ RecordType: "Weird" }, sink, 1)).toBeNull();
    expect(rec).toHaveLength(0);
    expect(verifyEmailWebhookSecret("s3cret", "s3cret")).toBe(true);
    expect(verifyEmailWebhookSecret("s3cret", "s3creT")).toBe(false);
    expect(verifyEmailWebhookSecret("s3cret", undefined)).toBe(false);
  });
  it("uses the template endpoint when a provider template id is present", async () => {
    const fake = new FakeFetch().enqueue(jsonRes(200, { ErrorCode: 0, MessageID: "m" }));
    const p = new PostmarkEmailProvider({ serverToken: "t", from: "f@x.test", messageStream: "outbound" }, testHttp(fake));
    await p.send({ ...base("email", "u@x.test"), channel: "email", providerTemplateId: "welcome-ar", locale: "ar" });
    expect(fake.requests[0]?.url).toBe("https://api.postmarkapp.com/email/withTemplate");
    expect((JSON.parse(fake.requests[0]?.body ?? "{}") as { TemplateAlias: string }).TemplateAlias).toBe("welcome-ar");
  });
});

describe("masking and compare", () => {
  it("masks", () => {
    expect(maskPhone(PHONE)).not.toContain("1001234");
    expect(maskEmail("user@example.com")).toBe("u***@example.com");
    expect(maskToken(TOKEN)).toBe("Expo***");
    expect(safeEqual("a", "a")).toBe(true);
    expect(safeEqual("a", "ab")).toBe(false);
  });
});

describe("selection and registry", () => {
  const deps = () => ({ http: testHttp(new FakeFetch()), nowMs: clock, deactivator: { deactivateToken: async () => undefined }, tickets: new InMemoryPushTicketStore(), suppression: { suppress: async () => undefined }, prefixBudget: null });
  beforeEach(() => resetBoundUnconfigured());

  it("every notification channel has a production binding choice", () => {
    for (const ch of EXTERNAL_CHANNELS) {
      expect(COMMS_BINDINGS[ch].vendors.length).toBeGreaterThan(0);
    }
    expect(Object.keys(COMMS_BINDINGS).sort()).toEqual([...EXTERNAL_CHANNELS].sort());
  });
  it("empty env: every channel stays Unconfigured and fails closed at call time with 503", async () => {
    const w = buildCommsWiring(parseCommsConfig({}), deps());
    expect(w.configured).toEqual([]);
    for (const ch of EXTERNAL_CHANNELS) {
      const [p] = w.registry.providersFor(ch);
      await expect(p?.send({ ...base(ch, "x"), channel: ch } as never)).rejects.toMatchObject({ status: 503 });
    }
    expect(await w.otpSender.send({ phoneE164: PHONE, code: "1", locale: "en", idempotencyKey: "k" })).toEqual({ ok: false, retryable: false, reason: "provider_not_configured" });
    expect(await providerStatus("messaging.email")).toBe("unconfigured");
  });
  it("complete env groups select real adapters; partial groups are reported and stay Unconfigured", async () => {
    const cfg = parseCommsConfig({
      EXPO_PUSH_ENABLED: "true",
      SMS_A_ACCOUNT_SID: "AC1", SMS_A_AUTH_TOKEN: "t", SMS_A_FROM: "OUTLET",
      SMS_B_ACCOUNT_SID: "AC2", SMS_B_AUTH_TOKEN: "t", // incomplete: no sender
      WHATSAPP_PHONE_NUMBER_ID: "1", WHATSAPP_ACCESS_TOKEN: "t", WHATSAPP_APP_SECRET: "s", WHATSAPP_OTP_TEMPLATE: "otp",
      EMAIL_POSTMARK_SERVER_TOKEN: "t",
    });
    expect(cfg.issues.map((i) => i.split(":")[0])).toEqual(["SMS_B", "EMAIL"]);
    const w = buildCommsWiring(cfg, deps());
    expect([...w.configured].sort()).toEqual(["push", "sms", "whatsapp"]);
    expect(w.registry.providersFor("sms").map((p) => p.code)).toEqual(["sms_a"]);
    expect(w.registry.providersFor("email")[0]?.code).toBe("unconfigured_email");
    expect(w.otpSender.id).toBe("failover(otp-sms_a>otp-wa_cloud)");
    expect(await providerStatus("push.apns-fcm")).toBe("configured");
  });
  it("sms registry order is A then B", () => {
    const w = buildCommsWiring(parseCommsConfig({ SMS_A_ACCOUNT_SID: "a", SMS_A_AUTH_TOKEN: "t", SMS_A_MESSAGING_SERVICE_SID: "m", SMS_B_ACCOUNT_SID: "b", SMS_B_AUTH_TOKEN: "t", SMS_B_FROM: "X" }), deps());
    expect(w.registry.providersFor("sms").map((p) => p.code)).toEqual(["sms_a", "sms_b"]);
  });
});
