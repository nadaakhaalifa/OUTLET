import "reflect-metadata";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  FIELD_CIPHER,
  EnvelopeFieldCipher,
  DevAesGcmFieldCipher,
  MEASUREMENTS_CONSENT,
  PrivacyMeasurementsConsent,
} from "../modules/sizing";
import {
  NOTIFICATION_CONSENT,
  NOTIFICATION_CONTACTS,
  NOTIFICATION_PROVIDERS,
  PROCESS_DUE_NOTIFICATIONS,
  FakeProvider,
  PrivacyConsentPort,
  type ProcessDue,
  type ProviderRegistry,
} from "../modules/notifications";
import { type ProblemError } from "../platform/problem";
import { ProviderNotConfiguredError } from "./unconfigured";
import { bootProduction, type ProductionTestApp } from "./test/test-support";

describe("production composition: sizing and notifications", () => {
  let t: ProductionTestApp;
  beforeAll(async () => {
    t = await bootProduction();
  }, 120_000);
  afterAll(async () => {
    await t.app.close();
  });
  const get = <T>(token: symbol): T => t.app.get<T>(token, { strict: false });

  it("sizing uses the KMS envelope cipher, never the dev cipher, and fails closed with 503 provider_not_configured", async () => {
    const cipher = get<unknown>(FIELD_CIPHER);
    expect(cipher).toBeInstanceOf(EnvelopeFieldCipher);
    expect(cipher).not.toBeInstanceOf(DevAesGcmFieldCipher);
    const c = cipher as EnvelopeFieldCipher;
    const err = await c.encrypt(new Uint8Array([1]), "size_profile:x:measurements").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderNotConfiguredError);
    expect((err as ProblemError).status).toBe(503);
    await expect(c.decrypt(new Uint8Array([0xe1, 0]), "a")).rejects.toThrow();
    await expect(c.blindIndex("p", "v")).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    expect(get<unknown>(MEASUREMENTS_CONSENT)).toBeInstanceOf(PrivacyMeasurementsConsent);
  });

  it("no consent means measurements consent is not granted (real privacy history, nothing pre-granted)", async () => {
    const consent = get<PrivacyMeasurementsConsent>(MEASUREMENTS_CONSENT);
    await expect(consent.isGranted("0190a000-0000-7000-8000-0000000000aa")).resolves.toBe(false);
  });

  it("notifications are wired to privacy consent and Unconfigured providers, no FakeProvider", async () => {
    expect(get<unknown>(NOTIFICATION_CONSENT)).toBeInstanceOf(PrivacyConsentPort);
    const reg = get<ProviderRegistry>(NOTIFICATION_PROVIDERS);
    for (const ch of ["push", "whatsapp", "sms", "email"] as const) {
      const ps = reg.providersFor(ch);
      expect(ps.length).toBeGreaterThan(0);
      for (const p of ps) {
        expect(p).not.toBeInstanceOf(FakeProvider);
        const e = await p
          .send({ requestId: "r", channel: ch, to: "x", subject: null, body: "b", providerTemplateId: null, locale: "ar" } as never)
          .catch((x: unknown) => x);
        expect(e).toBeInstanceOf(ProviderNotConfiguredError);
      }
    }
    const contacts = get<{ contact(u: string): Promise<unknown> }>(NOTIFICATION_CONTACTS);
    await expect(Promise.resolve().then(() => contacts.contact("u"))).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });

  it("the dispatcher worker job resolves in production and an idle run is a no-op", async () => {
    const job = get<ProcessDue>(PROCESS_DUE_NOTIFICATIONS);
    expect(await job.execute(100)).toEqual({ processed: 0, sent: 0, rescheduled: 0 });
  });
});

describe("no code path builds the dev cipher or a FakeProvider in production", () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") ? [p] : [];
    });

  it("production/compose.ts never references DevAesGcmFieldCipher or FakeProvider", () => {
    const src = readFileSync(join(__dirname, "compose.ts"), "utf8");
    expect(src).not.toMatch(/DevAesGcmFieldCipher|FakeProvider|InMemory(?!RateLimiter)/);
  });

  it("sizing and notifications construct the dev cipher / fakes only behind the in-memory-dev branch", () => {
    const sizing = readFileSync(join(__dirname, "../modules/sizing/sizing.module.ts"), "utf8");
    const dev = sizing.indexOf('config.adapters === "in-memory-dev" ? { cipher: new DevAesGcmFieldCipher()');
    expect(dev).toBeGreaterThan(-1);
    expect(sizing.match(/new DevAesGcmFieldCipher\(/g)).toHaveLength(1);
    const notif = readFileSync(join(__dirname, "../modules/notifications/notifications.module.ts"), "utf8");
    expect(notif).toMatch(/prod\?\.providers \?\? \(!devMode \? failClosed\(\)/);
    // no other non-test source in the two modules builds the dev cipher
    for (const f of walk(join(__dirname, "../modules/sizing"))) {
      if (f.endsWith("in-memory.ts") || f.endsWith("sizing.module.ts") || f.endsWith("index.ts") || f.includes("/test/")) continue;
      expect(readFileSync(f, "utf8"), f).not.toMatch(/new DevAesGcmFieldCipher/);
    }
  });
});
