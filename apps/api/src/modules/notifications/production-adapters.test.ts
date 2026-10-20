import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KyselyConsentRepository, type PrivacyDb } from "../privacy";
import { ProviderNotConfiguredError } from "../../production/unconfigured";
import { newTestDb } from "../../production/test/test-support";
import { seedTemplates } from "./adapters/seed-templates";
import {
  KyselyDeliveryLogRepository,
  KyselyFrequencyStore,
  KyselyInboxRepository,
  KyselyPreferenceRepository,
  KyselyPushTokenRepository,
  KyselyRequestRepository,
  KyselySuppressionRepository,
  KyselyTemplateRepository,
} from "./adapters/kysely-store";
import { KyselyInboxProcessed, LogNotificationEvents, DroppingAnalytics, PrivacyConsentPort, unconfiguredProviderRegistry } from "./adapters/production-adapters";
import { RegisterPushToken } from "./application/inbox";
import { SendNotification } from "./application/send-notification";
import type { ContactPort } from "./domain/ports";

const U = "0190a000-0000-7000-8000-0000000000b1";
const NOW = Date.UTC(2026, 9, 12, 10, 0, 0); // 13:00 Cairo, outside quiet hours

describe("notifications over the real Kysely stores with Unconfigured providers", () => {
  let db: Awaited<ReturnType<typeof newTestDb>>;
  beforeAll(async () => {
    db = await newTestDb();
    await sql`select set_config('app.role', 'system', false)`.execute(db);
    await sql`insert into users (id, status, locale, country) values (${U}::uuid, 'active', 'ar', 'EG')`.execute(db);
  }, 120_000);
  afterAll(async () => {
    await db.destroy();
  });

  it("registers a push token in the real store", async () => {
    const tokens = new KyselyPushTokenRepository(db);
    await new RegisterPushToken(tokens, { nowMs: () => NOW }).execute(U, { installId: "0190a000-0000-7000-8000-0000000000d1", platform: "ios", token: "ExponentPushToken[abc]" });
    expect((await tokens.active(U)).map((t) => t.token)).toEqual(["ExponentPushToken[abc]"]);
  });

  it("a send with unconfigured providers is recorded FAILED, never SENT", async () => {
    const templates = new KyselyTemplateRepository(db);
    // Seed ids ("seed-1") are not UUIDs, so the Postgres store needs them re-keyed (residual gap: no production seed step).
    for (const [i, t] of seedTemplates().entries()) await templates.save({ ...t, id: `0190a000-0000-7000-8000-${String(i + 500).padStart(12, "0")}` });
    const requests = new KyselyRequestRepository(db);
    const log = new KyselyDeliveryLogRepository(db);
    const contacts: ContactPort = { contact: async () => ({ locale: "ar", phone: "+201001230000", email: null }) };
    let n = 0;
    const consents = new KyselyConsentRepository(db as unknown as PrivacyDb);
    const send = new SendNotification({
      templates, requests, log,
      frequency: new KyselyFrequencyStore(db),
      preferences: new KyselyPreferenceRepository(db),
      suppressions: new KyselySuppressionRepository(db),
      inbox: new KyselyInboxRepository(db),
      tokens: new KyselyPushTokenRepository(db),
      consent: new PrivacyConsentPort(consents),
      contacts,
      providers: unconfiguredProviderRegistry({
        push: (o) => new ProviderNotConfiguredError("push.apns-fcm", o),
        whatsapp: (o) => new ProviderNotConfiguredError("messaging.sms-whatsapp", o),
        sms: (o) => new ProviderNotConfiguredError("messaging.sms-whatsapp", o),
        email: (o) => new ProviderNotConfiguredError("messaging.email", o),
      }),
      events: new LogNotificationEvents(),
      analytics: new DroppingAnalytics(),
      clock: { nowMs: () => NOW },
      ids: { uuidV7: () => `0190a000-0000-7000-8000-${String(++n + 100).padStart(12, "0")}` },
    });
    const r = await send.execute({ userId: U, templateKey: "order_confirmed", ref: "order-1", payload: {} });
    expect(JSON.stringify(r)).not.toContain('"status":"SENT"');
    const stored = await requests.find(U, "order_confirmed", "order-1");
    expect(stored?.status).not.toBe("SENT");
    const entries = await log.forRequest(stored?.id ?? "");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.status !== "SENT")).toBe(true);
  });

  it("marketing consent is read from privacy history: not granted without a record", async () => {
    const c = new PrivacyConsentPort(new KyselyConsentRepository(db as unknown as PrivacyDb));
    await expect(c.isGranted(U, "marketing_push")).resolves.toBe(false);
  });

  it("inbox dedupe: second delivery is a duplicate, a failing effect releases the mark", async () => {
    const p = new KyselyInboxProcessed(db);
    const id = "0190a000-0000-7000-8000-0000000000c1";
    expect((await p.runOnce("c", id, async () => 1)).kind).toBe("done");
    expect((await p.runOnce("c", id, async () => 1)).kind).toBe("duplicate");
    const id2 = "0190a000-0000-7000-8000-0000000000c2";
    await expect(p.runOnce("c", id2, async () => { throw new Error("x"); })).rejects.toThrow();
    expect((await p.runOnce("c", id2, async () => 2)).kind).toBe("done");
  });
});
