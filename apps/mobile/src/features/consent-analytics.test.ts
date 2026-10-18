import { describe, expect, it } from "vitest";
import { ConsentController, CONSENT_VERSIONS, type PersistedConsent } from "./consent";
import { ClientAnalytics } from "./analytics";
import { DevFakeApi } from "../api/dev-fake";
import { CONSENT_PURPOSES, createRecordingTransport } from "../workspace";

function setup(opts: { offline?: boolean } = {}) {
  let now = Date.parse("2026-10-10T12:00:00Z");
  const clock = { now: () => new Date(now) };
  const api = new DevFakeApi({ clock, offline: opts.offline === true });
  let stored: PersistedConsent | null = null;
  const controller = new ConsentController({
    clock,
    api,
    persistence: {
      read: async () => stored,
      write: async (d) => {
        stored = d;
      },
    },
  });
  let n = 0;
  const transport = createRecordingTransport();
  let starts = 0;
  let stops = 0;
  const analytics = new ClientAnalytics({
    consent: controller,
    versions: CONSENT_VERSIONS,
    clock,
    ids: { next: () => `id${String(++n).padStart(20, "0")}` },
    start: () => {
      starts += 1;
      return { transport, stop: () => void (stops += 1) };
    },
  });
  return { controller, analytics, transport, api, tick: (ms: number) => void (now += ms), counts: () => ({ starts, stops }), stored: () => stored };
}

describe("ConsentController", () => {
  it("starts with nothing granted", () => {
    const { controller } = setup();
    expect(Object.values(controller.view()).every((v) => v === false)).toBe(true);
    for (const p of CONSENT_PURPOSES) expect(controller.isGranted(p)).toBe(false);
  });
  it("skipping the screen (empty selection) grants nothing", async () => {
    const { controller, api } = setup();
    await controller.saveOnboardingChoices({});
    expect(Object.values(controller.view()).some(Boolean)).toBe(false);
    expect(api.recordedConsents).toHaveLength(0);
  });
  it("grants only what was ticked and syncs it", async () => {
    const { controller, api } = setup();
    await controller.saveOnboardingChoices({ analytics: true, marketing_push: false });
    expect(controller.isGranted("analytics")).toBe(true);
    expect(controller.isGranted("marketing_push")).toBe(false);
    expect(api.recordedConsents.map((c) => c.purpose)).toEqual(["analytics"]);
    expect(controller.pendingCount).toBe(0);
  });
  it("withdrawal is immediate and survives an offline API", async () => {
    const { controller } = setup({ offline: true });
    await controller.set("analytics", true, "settings_toggle");
    expect(controller.pendingCount).toBe(1);
    await controller.set("analytics", false, "settings_toggle");
    expect(controller.isGranted("analytics")).toBe(false);
    expect(controller.pendingCount).toBe(1);
  });
  it("restores from persistence including pending sync", async () => {
    const a = setup({ offline: true });
    await a.controller.set("personalization", true, "settings_toggle");
    const snapshot = a.stored();
    expect(snapshot?.pending).toEqual(["personalization"]);
    const clock = { now: () => new Date("2026-10-11T00:00:00Z") };
    const api = new DevFakeApi({ clock });
    const b = new ConsentController({ clock, api, persistence: { read: async () => snapshot, write: async () => undefined } });
    await b.load();
    expect(b.isGranted("personalization")).toBe(true);
    await b.flushPending();
    expect(api.recordedConsents).toHaveLength(1);
    expect(b.pendingCount).toBe(0);
  });
});

describe("ClientAnalytics", () => {
  it("creates nothing before analytics consent and sends nothing", async () => {
    const { analytics, counts, transport } = setup();
    expect(analytics.sync()).toBe("unchanged");
    expect(counts().starts).toBe(0);
    expect(await analytics.trackOnboardingStep("account", false)).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });
  it("an unrelated consent does not start analytics", async () => {
    const { controller, analytics, counts } = setup();
    await controller.set("marketing_push", true, "settings_toggle");
    expect(analytics.sync()).toBe("unchanged");
    expect(counts().starts).toBe(0);
  });
  it("starts after consent, sends, and stops on withdrawal", async () => {
    const { controller, analytics, transport, counts } = setup();
    await controller.set("analytics", true, "onboarding_toggle");
    expect(analytics.sync()).toBe("started");
    expect(analytics.sync()).toBe("unchanged");
    expect(await analytics.trackOnboardingStep("language", true)).toBe(true);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]?.name).toBe("onboarding_step_completed");
    await controller.set("analytics", false, "settings_toggle");
    expect(analytics.sync()).toBe("stopped");
    expect(counts().stops).toBe(1);
    expect(await analytics.trackOnboardingStep("consents", false)).toBe(false);
    expect(transport.sent).toHaveLength(1);
  });
  it("never emits even if sync was not called after withdrawal", async () => {
    const { controller, analytics, transport } = setup();
    await controller.set("analytics", true, "onboarding_toggle");
    analytics.sync();
    await controller.set("analytics", false, "settings_toggle");
    expect(await analytics.trackOnboardingStep("account", false)).toBe(false);
    expect(transport.sent).toHaveLength(0);
  });
  it("does not track the done step", async () => {
    const { controller, analytics } = setup();
    await controller.set("analytics", true, "onboarding_toggle");
    analytics.sync();
    expect(await analytics.trackOnboardingStep("done", false)).toBe(false);
  });
});
