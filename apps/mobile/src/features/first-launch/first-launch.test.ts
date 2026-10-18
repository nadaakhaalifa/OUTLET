import { describe, expect, it } from "vitest";
import { ConsentController, CONSENT_VERSIONS, type PersistedConsent } from "../consent";
import { ClientAnalytics } from "../analytics";
import { DevFakeApi } from "../../api/dev-fake";
import { createRecordingTransport } from "../../workspace";
import { answerAnalyticsBanner, shouldShowAnalyticsBanner } from "./model";

function setup() {
  const clock = { now: () => new Date("2026-10-18T12:00:00Z") };
  let stored: PersistedConsent | null = null;
  const consent = new ConsentController({ clock, api: new DevFakeApi({ clock }), persistence: { read: async () => stored, write: async (d) => { stored = d; } } });
  let n = 0;
  let starts = 0;
  const analytics = new ClientAnalytics({
    consent, versions: CONSENT_VERSIONS, clock,
    ids: { next: () => `id${String(++n).padStart(20, "0")}` },
    start: () => { starts += 1; return { transport: createRecordingTransport(), stop: () => undefined }; },
  });
  return { consent, analytics, starts: () => starts };
}

describe("analytics banner", () => {
  it("shows on a fresh device with nothing granted and nothing started", () => {
    const { consent, analytics, starts } = setup();
    analytics.sync();
    expect(shouldShowAnalyticsBanner(consent.history())).toBe(true);
    expect(consent.isGranted("analytics")).toBe(false);
    expect(starts()).toBe(0);
  });
  it("Allow records consent and only then starts analytics", async () => {
    const { consent, analytics, starts } = setup();
    await answerAnalyticsBanner(consent, "allow");
    analytics.sync();
    expect(consent.isGranted("analytics")).toBe(true);
    expect(starts()).toBe(1);
    expect(shouldShowAnalyticsBanner(consent.history())).toBe(false);
  });
  it("Not now records a decline, never starts analytics, and is not asked again", async () => {
    const { consent, analytics, starts } = setup();
    await answerAnalyticsBanner(consent, "not_now");
    analytics.sync();
    expect(consent.isGranted("analytics")).toBe(false);
    expect(starts()).toBe(0);
    expect(shouldShowAnalyticsBanner(consent.history())).toBe(false);
  });
});

describe("guest consent stays on the device", () => {
  it("no network call as a guest; flushed once after sign-in", async () => {
    const clock = { now: () => new Date("2026-10-18T12:00:00Z") };
    let signedIn = false;
    const calls: string[] = [];
    let stored: PersistedConsent | null = null;
    const consent = new ConsentController({
      clock,
      api: { recordConsent: async (c) => { calls.push(c.purpose); return { ok: true, value: undefined }; } },
      canSync: async () => signedIn,
      persistence: { read: async () => stored, write: async (d) => { stored = d; } },
    });
    await answerAnalyticsBanner(consent, "allow");
    expect(consent.isGranted("analytics")).toBe(true);
    expect(calls).toEqual([]);
    signedIn = true;
    await consent.flushPending();
    await consent.flushPending();
    expect(calls).toEqual(["analytics"]);
  });
});
