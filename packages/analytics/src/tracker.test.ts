import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { analyticsEvents, ANALYTICS_EVENT_NAMES } from "./analytics-events";
import { inspectProperties } from "./pii";
import { VALID_PROPS } from "./test-fixtures";
import type { Clock, EventEnvelope, IdGenerator, PseudonymousIdProvider, Transport } from "./ports";
import { CONSENT_PURPOSES, type ConsentChecker, type ConsentPurpose, type EventOrigin } from "./purposes";
import { ConsentGatedTracker, createRecordingTransport } from "./tracker";

const PX = `px_${"a".repeat(24)}`;
const clock: Clock = { now: () => new Date("2026-10-10T12:00:00Z") };
const provider = (): PseudonymousIdProvider & { calls: number } => {
  const p = { calls: 0, current: () => ((p.calls += 1), PX) };
  return p;
};
const ids = (): IdGenerator => {
  let n = 0;
  return { next: () => `evt_${++n}` };
};
const grants = (granted: ReadonlySet<ConsentPurpose>): ConsentChecker => ({ isGranted: (p) => granted.has(p) });

function build(origin: EventOrigin, granted: ReadonlySet<ConsentPurpose>, transport: Transport = createRecordingTransport()) {
  const px = provider();
  const tracker = new ConsentGatedTracker({ origin, consent: grants(granted), transport, clock, ids: ids(), pseudonymousId: px });
  return { tracker, px, transport };
}

const purposeSetArb = fc.subarray([...CONSENT_PURPOSES]).map((a) => new Set<ConsentPurpose>(a));
const eventArb = fc.constantFrom(...ANALYTICS_EVENT_NAMES);
const originArb = fc.constantFrom<EventOrigin>("client", "server");

describe("ConsentGatedTracker", () => {
  it("sends an event when its purpose is granted, with a well-formed envelope", async () => {
    const { tracker, transport } = build("client", new Set(["analytics"]));
    const r = await tracker.track("app_open", VALID_PROPS.app_open);
    expect(r).toEqual({ status: "sent", eventId: "evt_1" });
    const sent = (transport as ReturnType<typeof createRecordingTransport>).sent;
    expect(sent).toEqual<EventEnvelope[]>([
      {
        event_id: "evt_1",
        name: "app_open",
        occurred_at: "2026-10-10T12:00:00.000Z",
        pseudonymous_id: PX,
        origin: "client",
        purpose: "analytics",
        schema_version: 1,
        properties: VALID_PROPS.app_open,
      },
    ]);
  });

  it("drops without consent and never even asks for the pseudonymous id", async () => {
    const { tracker, px, transport } = build("client", new Set());
    const r = await tracker.track("app_open", VALID_PROPS.app_open);
    expect(r).toEqual({ status: "dropped", reason: "consent_not_granted" });
    expect(px.calls).toBe(0);
    expect((transport as ReturnType<typeof createRecordingTransport>).sent).toHaveLength(0);
  });

  it("analytics consent does not unlock budget or measurement events", async () => {
    const { tracker } = build("client", new Set(["analytics", "personalization"]));
    expect(await tracker.track("budget_set", VALID_PROPS.budget_set)).toMatchObject({ reason: "consent_not_granted" });
    expect(await tracker.track("fit_feedback_submitted", VALID_PROPS.fit_feedback_submitted)).toMatchObject({
      reason: "consent_not_granted",
    });
  });

  it("a client tracker cannot emit a server-origin event, even strictly necessary ones", async () => {
    const { tracker } = build("client", new Set(CONSENT_PURPOSES));
    expect(await tracker.track("order_placed", VALID_PROPS.order_placed)).toEqual({ status: "dropped", reason: "wrong_origin" });
  });

  it("a server tracker emits strictly necessary events without any consent", async () => {
    const { tracker } = build("server", new Set());
    expect((await tracker.track("order_placed", VALID_PROPS.order_placed)).status).toBe("sent");
    expect((await tracker.track("consent_changed", VALID_PROPS.consent_changed)).status).toBe("sent");
  });

  it("drops unknown events, extra properties and wrong types", async () => {
    const { tracker } = build("client", new Set(CONSENT_PURPOSES));
    expect(await tracker.track("made_up_event", {})).toEqual({ status: "dropped", reason: "unknown_event" });
    expect(await tracker.track("__proto__", {})).toEqual({ status: "dropped", reason: "unknown_event" });
    expect(await tracker.track("app_open", { ...VALID_PROPS.app_open, email: "a@b.co" })).toMatchObject({
      reason: "invalid_properties",
    });
    expect(await tracker.track("app_open", { launch_type: "hot", source: "icon" })).toMatchObject({ reason: "invalid_properties" });
  });

  it("drops a PII-shaped value because bounded fields reject it before the transport", async () => {
    const { tracker, transport } = build("client", new Set(["analytics"]));
    expect(await tracker.track("app_open", { launch_type: "cold", source: "01012345678" })).toMatchObject({ reason: "invalid_properties" });
    expect(await tracker.track("store_viewed", { store_id: "a@b.co", world: "local", source: "feed" })).toMatchObject({ reason: "invalid_properties" });
    expect((transport as ReturnType<typeof createRecordingTransport>).sent).toHaveLength(0);
  });

  it("contains a throwing transport, checker and id provider and never emits", async () => {
    const boom = new Error("boom");
    const t1 = build("client", new Set(["analytics"]), {
      send() {
        throw boom;
      },
    });
    expect(await t1.tracker.track("app_open", VALID_PROPS.app_open)).toEqual({ status: "dropped", reason: "transport_failed" });

    const rejecting = build("client", new Set(["analytics"]), { send: () => Promise.reject(boom) });
    expect(await rejecting.tracker.track("app_open", VALID_PROPS.app_open)).toMatchObject({ reason: "transport_failed" });

    const rec = createRecordingTransport();
    const badChecker = new ConsentGatedTracker({
      origin: "client",
      consent: {
        isGranted() {
          throw boom;
        },
      },
      transport: rec,
      clock,
      ids: ids(),
      pseudonymousId: provider(),
    });
    expect(await badChecker.track("app_open", VALID_PROPS.app_open)).toEqual({ status: "dropped", reason: "internal_error" });
    expect(rec.sent).toHaveLength(0);
  });

  it("drops when the id provider returns something that is not a pseudonymous id", async () => {
    const rec = createRecordingTransport();
    const tracker = new ConsentGatedTracker({
      origin: "client",
      consent: grants(new Set(["analytics"])),
      transport: rec,
      clock,
      ids: ids(),
      pseudonymousId: { current: () => "user@example.com" },
    });
    expect(await tracker.track("app_open", VALID_PROPS.app_open)).toEqual({ status: "dropped", reason: "invalid_pseudonymous_id" });
    expect(rec.sent).toHaveLength(0);
  });

  it("respects withdrawal immediately: the checker is consulted on every call", async () => {
    const granted = new Set<ConsentPurpose>(["analytics"]);
    const rec = createRecordingTransport();
    const tracker = new ConsentGatedTracker({ origin: "client", consent: grants(granted), transport: rec, clock, ids: ids(), pseudonymousId: provider() });
    expect((await tracker.track("app_open", VALID_PROPS.app_open)).status).toBe("sent");
    granted.delete("analytics");
    expect((await tracker.track("app_open", VALID_PROPS.app_open)).status).toBe("dropped");
    expect(rec.sent).toHaveLength(1);
  });

  it("re-checks consent after validation: withdrawal during the call stops the send", async () => {
    let calls = 0;
    const rec = createRecordingTransport();
    const tracker = new ConsentGatedTracker({
      origin: "client",
      consent: { isGranted: () => ++calls === 1 },
      transport: rec,
      clock,
      ids: ids(),
      pseudonymousId: provider(),
    });
    expect(await tracker.track("app_open", VALID_PROPS.app_open)).toEqual({ status: "dropped", reason: "consent_not_granted" });
    expect(rec.sent).toHaveLength(0);
  });
});

describe("consent invariants (property tests)", () => {
  it("never emits an event unless its purpose is granted or it is a server strictly-necessary event", async () => {
    await fc.assert(
      fc.asyncProperty(eventArb, purposeSetArb, originArb, async (name, granted, origin) => {
        const rec = createRecordingTransport();
        const tracker = new ConsentGatedTracker({ origin, consent: grants(granted), transport: rec, clock, ids: ids(), pseudonymousId: provider() });
        const def = analyticsEvents[name];
        const result = await tracker.track(name, VALID_PROPS[name]);

        const originOk = def.origin === "client" || origin === "server";
        const consentOk = def.purpose === "strictly_necessary" || granted.has(def.purpose);
        const shouldSend = originOk && consentOk;

        expect(result.status === "sent").toBe(shouldSend);
        expect(rec.sent).toHaveLength(shouldSend ? 1 : 0);
        for (const env of rec.sent) {
          expect(env.purpose === "strictly_necessary" || granted.has(env.purpose)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("with no consent at all, only server strictly-necessary events can ever be emitted", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(eventArb, { minLength: 1, maxLength: 30 }), originArb, async (names, origin) => {
        const rec = createRecordingTransport();
        const tracker = new ConsentGatedTracker({ origin, consent: grants(new Set()), transport: rec, clock, ids: ids(), pseudonymousId: provider() });
        for (const n of names) await tracker.track(n, VALID_PROPS[n]);
        for (const env of rec.sent) {
          expect(env.purpose).toBe("strictly_necessary");
          expect(env.origin).toBe("server");
        }
        if (origin === "client") expect(rec.sent).toHaveLength(0);
      }),
    );
  });

  it("a withdrawal mid-sequence stops every later event that needs consent", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(eventArb, { minLength: 2, maxLength: 25 }), fc.nat(24), async (names, cut) => {
        const granted = new Set<ConsentPurpose>(CONSENT_PURPOSES);
        const rec = createRecordingTransport();
        const tracker = new ConsentGatedTracker({ origin: "server", consent: grants(granted), transport: rec, clock, ids: ids(), pseudonymousId: provider() });
        const at = cut % names.length;
        for (const [i, n] of names.entries()) {
          if (i === at) granted.clear();
          await tracker.track(n, VALID_PROPS[n]);
        }
        const strictLate = names.slice(at).filter((n) => analyticsEvents[n].purpose === "strictly_necessary").length;
        expect(rec.sent).toHaveLength(at + strictLate);
        for (const env of rec.sent.slice(at)) expect(env.purpose).toBe("strictly_necessary");
      }),
    );
  });

  it("no envelope ever carries a property the PII policy would reject", async () => {
    await fc.assert(
      fc.asyncProperty(eventArb, async (name) => {
        const rec = createRecordingTransport();
        const tracker = new ConsentGatedTracker({ origin: "server", consent: grants(new Set(CONSENT_PURPOSES)), transport: rec, clock, ids: ids(), pseudonymousId: provider() });
        await tracker.track(name, VALID_PROPS[name]);
        for (const env of rec.sent) expect(inspectProperties(env.properties)).toEqual([]);
      }),
    );
  });
});
