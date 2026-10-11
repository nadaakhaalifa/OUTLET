import type { EventOrigin, EventPurpose } from "./purposes";

/** Injected clock. The package never reads the system time itself. */
export interface Clock {
  now(): Date;
}

/** Injected id source (event ids, pseudonymous ids). The package never calls a random function itself. */
export interface IdGenerator {
  next(): string;
}

/** The wire shape of one analytics event. Contains no user id, no device id and no free text. */
export interface EventEnvelope {
  readonly event_id: string;
  readonly name: string;
  /** ISO-8601 instant from the injected clock. */
  readonly occurred_at: string;
  readonly pseudonymous_id: string;
  readonly origin: EventOrigin;
  readonly purpose: EventPurpose;
  /** Per-event schema version from the catalog. */
  readonly schema_version: number;
  /** Client platform, when known (Android launch, phase2/11). */
  readonly platform?: "ios" | "android" | "web" | "server";
  readonly properties: Readonly<Record<string, unknown>>;
}

/** Port: delivers an envelope (PostHog, an ingest endpoint, ...). May throw or reject; the tracker contains it. */
export interface Transport {
  send(envelope: EventEnvelope): void | Promise<void>;
}

/** Port: supplies the current pseudonymous id. Called only after the consent gate has passed. */
export interface PseudonymousIdProvider {
  current(): string;
}
