import { createHmac } from "node:crypto";
import {
  AnalyticsClientEvent,
  AnalyticsEventBatchEnvelope,
  MAX_IMPRESSION_ITEMS,
  findForbiddenKey,
} from "../domain/client-events";
import { ANALYTICS_EVENT_TYPES, type AnalyticsOutboxDraft } from "../domain/events";
import {
  AttestationRequiredError,
  IngestDisabledError,
  IngestRateLimitedError,
  IngestStoreUnavailableError,
  InvalidBatchError,
  PlausibilityUnavailableError,
  type AttestationCheck,
  type BatchOutbox,
  type ConsentReader,
  type IngestCounters,
  type IngestGate,
  type PlausibilityStore,
} from "../domain/ports";
import type { ShopperKeyer } from "../domain/producers";
import { classifyTerm, type TermVocabulary } from "../domain/terms";

const MIN = 60_000;
const DAY = 86_400_000;
const DEDUPE_TTL_S = 900; // 15 minutes
const EVENT_ID_TTL_S = 7 * 86_400;
export const EVENTS_PER_USER_PER_MINUTE = 600;

export interface IngestInput {
  readonly userId: string;
  readonly attestation: { readonly platform: "ios" | "android"; readonly token: string } | null;
  readonly body: unknown;
  readonly nowMs: number;
  readonly batchId: string;
}
export interface IngestResult {
  readonly accepted: number;
  readonly duplicates: number;
  readonly rejected: number;
}

export interface IngestDeps {
  readonly gate: IngestGate;
  readonly attestation: AttestationCheck;
  readonly consent: ConsentReader;
  readonly store: PlausibilityStore;
  readonly outbox: BatchOutbox;
  readonly keyer: ShopperKeyer;
  readonly vocabulary: TermVocabulary;
  readonly counters: IngestCounters;
  /** Key used to HMAC dedupe keys so the plausibility store never holds a raw user id. */
  readonly dedupeKey: Uint8Array;
}

/**
 * Client analytics batch ingest (spec section 5). Order: forbidden keys, envelope, sent_at, uncached
 * consent, per-user event cap, then per-event validation and plausibility. The identity is replaced
 * by `shopper_key` before the single outbox write; no user id, device id or IP is stored.
 */
export class IngestAnalyticsBatch {
  constructor(private readonly d: IngestDeps) {}

  private h(...parts: readonly string[]): string {
    return createHmac("sha256", this.d.dedupeKey).update(parts.join("\0")).digest("hex");
  }

  async execute(input: IngestInput): Promise<IngestResult> {
    // kill.analytics.ingest: blocked means nothing is read, validated or stored.
    let on: boolean;
    try {
      on = (await this.d.gate.enabled()) === true;
    } catch {
      on = false;
    }
    if (!on) throw new IngestDisabledError();
    // Device attestation (H2): missing or invalid is 401 attestation_required, counted.
    if (input.attestation === null || !(await this.d.attestation.verify(input.attestation.platform, input.attestation.token)).ok) {
      this.d.counters.inc("attestation_required");
      throw new AttestationRequiredError();
    }
    const forbidden = findForbiddenKey(input.body);
    if (forbidden !== null) {
      this.d.counters.inc("forbidden_property");
      throw new InvalidBatchError("forbidden_property");
    }
    const env = AnalyticsEventBatchEnvelope.safeParse(input.body);
    if (!env.success) {
      this.d.counters.inc("invalid_envelope");
      throw new InvalidBatchError("validation_failed");
    }
    const events = env.data.events;
    const sentAtMs = Date.parse(env.data.sent_at);
    if (sentAtMs > input.nowMs + 5 * MIN) {
      this.d.counters.inc("sent_at_future", events.length);
      return { accepted: 0, duplicates: 0, rejected: events.length };
    }

    // M4: read the consent on EVERY batch, uncached, so a withdrawal applies to the very next batch.
    if (!(await this.d.consent.analyticsConsent(input.userId))) {
      this.d.counters.inc("no_consent");
      return { accepted: 0, duplicates: 0, rejected: 0 };
    }

    try {
      return await this.process(input, events, sentAtMs);
    } catch (e) {
      if (e instanceof IngestRateLimitedError || e instanceof InvalidBatchError || e instanceof IngestStoreUnavailableError) throw e;
      throw new PlausibilityUnavailableError();
    }
  }

  private async process(input: IngestInput, events: readonly unknown[], sentAtMs: number): Promise<IngestResult> {
    const user = this.h("user", input.userId);
    const total = await this.d.store.addToWindow(`an:evt:${user}`, 60, events.length);
    if (total > EVENTS_PER_USER_PER_MINUTE) {
      this.d.counters.inc("user_event_cap", events.length);
      throw new IngestRateLimitedError(60);
    }

    const setKeys: string[] = [];
    const firstSeen = async (key: string, ttl: number): Promise<boolean> => {
      const fresh = await this.d.store.setIfAbsent(key, ttl);
      if (fresh) setKeys.push(key);
      return fresh;
    };

    let duplicates = 0;
    let rejected = 0;
    const reject = (reason: string): void => {
      rejected += 1;
      this.d.counters.inc(reason);
    };
    const accepted: Record<string, unknown>[] = [];

    for (const raw of events) {
      const parsed = AnalyticsClientEvent.safeParse(raw);
      if (!parsed.success) {
        reject("invalid_event");
        continue;
      }
      const ev = parsed.data;
      const occurredMs = Date.parse(ev.occurred_at);
      if (occurredMs > sentAtMs + 5_000) {
        reject("occurred_after_sent_at");
        continue;
      }
      if (occurredMs < input.nowMs - 7 * DAY || occurredMs > input.nowMs + 5 * MIN) {
        reject("occurred_out_of_range");
        continue;
      }
      if (!(await firstSeen(`an:id:${this.h("event", ev.event_id)}`, EVENT_ID_TTL_S))) {
        duplicates += 1;
        continue;
      }
      const base = { event_id: ev.event_id, name: ev.name, occurred_at_ms: occurredMs };

      switch (ev.name) {
        case "product_impressions": {
          const positions = new Set(ev.properties.items.map((i) => i.position));
          if (positions.size !== ev.properties.items.length) {
            reject("duplicate_position");
            break;
          }
          const fresh: typeof ev.properties.items = [];
          for (const item of ev.properties.items) {
            if (await firstSeen(`an:dd:${this.h("seen", input.userId, item.product_id, ev.properties.surface)}`, DEDUPE_TTL_S)) fresh.push(item);
          }
          if (fresh.length === 0) {
            duplicates += 1;
            break;
          }
          const used = await this.d.store.addToWindow(`an:imp:${this.h("imp", input.userId, ev.properties.surface)}`, 60, fresh.length);
          if (used > MAX_IMPRESSION_ITEMS) {
            reject("impression_cap");
            break;
          }
          accepted.push({ ...base, properties: { surface: ev.properties.surface, items: fresh } });
          break;
        }
        case "product_viewed": {
          if (!(await firstSeen(`an:dd:${this.h("seen", input.userId, ev.properties.product_id, ev.properties.source)}`, DEDUPE_TTL_S))) {
            duplicates += 1;
            break;
          }
          accepted.push({ ...base, properties: ev.properties });
          break;
        }
        case "search_result_clicked": {
          const decision = await classifyTerm(ev.properties.term, this.d.vocabulary, (t) => this.d.keyer.termHash(t));
          if (decision.kind === "rejected") {
            reject(`term_${decision.reason}`);
            break;
          }
          const { store_id, product_id } = ev.properties;
          accepted.push({
            ...base,
            properties: decision.kind === "vocabulary" ? { store_id, product_id, term: decision.term } : { store_id, product_id, term_hash: decision.termHash },
          });
          break;
        }
        default:
          accepted.push({ ...base, properties: ev.properties });
      }
    }

    if (accepted.length > 0) {
      const draft: AnalyticsOutboxDraft = {
        id: input.batchId,
        type: ANALYTICS_EVENT_TYPES.clientBatch,
        aggregateType: "analytics_batch",
        aggregateId: input.batchId,
        occurredAtMs: input.nowMs,
        // Pseudonymous key only (consent was just re-checked). No user id, device id or IP.
        payload: { v: 1, sent_at_ms: sentAtMs, shopper_key: this.d.keyer.shopperKey(input.userId), events: accepted },
      };
      try {
        await this.d.outbox.append(draft);
      } catch {
        await this.d.store.release(setKeys).catch(() => undefined);
        throw new IngestStoreUnavailableError();
      }
    }
    return { accepted: accepted.length, duplicates, rejected };
  }
}
