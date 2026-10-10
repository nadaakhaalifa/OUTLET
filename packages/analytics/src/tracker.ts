import { z } from "zod";
import { analyticsEvents, isAnalyticsEventName, type AnalyticsEventInput, type AnalyticsEventName } from "./analytics-events";
import { inspectProperties, type PiiViolation } from "./pii";
import type { Clock, EventEnvelope, IdGenerator, PseudonymousIdProvider, Transport } from "./ports";
import { STRICTLY_NECESSARY, type ConsentChecker, type EventOrigin } from "./purposes";

export type DropReason =
  | "unknown_event"
  | "wrong_origin"
  | "consent_not_granted"
  | "invalid_properties"
  | "pii_policy_violation"
  | "invalid_pseudonymous_id"
  | "internal_error"
  | "transport_failed";

export type TrackResult =
  | { readonly status: "sent"; readonly eventId: string }
  | { readonly status: "dropped"; readonly reason: DropReason; readonly detail?: readonly string[] };

export interface TrackerDeps {
  /** Which side of the system this tracker runs on. A client tracker can never emit a server-origin event. */
  readonly origin: EventOrigin;
  readonly consent: ConsentChecker;
  readonly transport: Transport;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly pseudonymousId: PseudonymousIdProvider;
}

const pseudonymOk = z.string().regex(/^px_[A-Za-z0-9_-]{16,64}$/);

/**
 * Consent-gated tracker. Guarantees, in order, for every call:
 *  1. the event exists in the catalog and its origin matches this tracker;
 *  2. the matching consent purpose is granted right now (the checker is consulted on every call, never cached),
 *     except `strictly_necessary` server events;
 *  3. properties pass the event's strict Zod schema AND the PII policy;
 *  4. only then is the pseudonymous id requested and the transport called.
 * `track` never throws and never emits on any failed step. There is no retry and no buffering: a
 * dropped event is gone, so nothing can be replayed after consent is withdrawn.
 */
export class ConsentGatedTracker {
  constructor(private readonly deps: TrackerDeps) {}

  async track<N extends AnalyticsEventName>(name: N, properties: AnalyticsEventInput<N>): Promise<TrackResult>;
  async track(name: string, properties: unknown): Promise<TrackResult>;
  async track(name: string, properties: unknown): Promise<TrackResult> {
    const { origin, consent, transport, clock, ids, pseudonymousId } = this.deps;

    if (!isAnalyticsEventName(name)) return { status: "dropped", reason: "unknown_event" };
    const def = analyticsEvents[name];

    if (def.origin === "server" && origin !== "server") return { status: "dropped", reason: "wrong_origin" };

    try {
      if (def.purpose !== STRICTLY_NECESSARY && !consent.isGranted(def.purpose)) {
        return { status: "dropped", reason: "consent_not_granted" };
      }

      const parsed = def.schema.safeParse(properties);
      if (!parsed.success) {
        return { status: "dropped", reason: "invalid_properties", detail: parsed.error.issues.map((i) => i.path.join(".")) };
      }
      const violations: PiiViolation[] = inspectProperties(parsed.data);
      if (violations.length > 0) {
        return { status: "dropped", reason: "pii_policy_violation", detail: violations.map((v) => `${v.path}:${v.code}`) };
      }

      // Re-check immediately before the id is minted and the event leaves: consent may have been
      // withdrawn by a listener between the first check and here.
      if (def.purpose !== STRICTLY_NECESSARY && !consent.isGranted(def.purpose)) {
        return { status: "dropped", reason: "consent_not_granted" };
      }

      const id = pseudonymOk.safeParse(pseudonymousId.current());
      if (!id.success) return { status: "dropped", reason: "invalid_pseudonymous_id" };

      const envelope: EventEnvelope = {
        event_id: ids.next(),
        name,
        occurred_at: clock.now().toISOString(),
        pseudonymous_id: id.data,
        origin,
        purpose: def.purpose,
        schema_version: 1,
        properties: parsed.data,
      };
      try {
        await transport.send(envelope);
      } catch {
        return { status: "dropped", reason: "transport_failed" };
      }
      return { status: "sent", eventId: envelope.event_id };
    } catch {
      // Consent checker, id provider, clock or id generator threw before send. Never emit, never propagate.
      return { status: "dropped", reason: "internal_error" };
    }
  }
}

/**
 * In-memory transport for tests and local development ONLY. It records envelopes in a list and sends
 * nothing anywhere. It is a development fixture, not an analytics backend.
 */
export function createRecordingTransport(): Transport & { readonly sent: EventEnvelope[] } {
  const sent: EventEnvelope[] = [];
  return {
    sent,
    send(envelope) {
      sent.push(envelope);
    },
  };
}
