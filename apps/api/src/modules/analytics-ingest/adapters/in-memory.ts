import type { AnalyticsOutboxDraft } from "../domain/events";
import {
  PlausibilityUnavailableError,
  type AttestationCheck,
  type AttestationVerdictLite,
  type BatchOutbox,
  type ConsentReader,
  type IngestCounters,
  type IngestGate,
  type PlausibilityStore,
} from "../domain/ports";
import type { ProducerGate, ShopperKeyer } from "../domain/producers";
import type { TermVocabulary } from "../domain/terms";

/** Test and in-memory dev gate. Defaults to BLOCKED, like the registry default. */
export class StaticGate implements IngestGate, ProducerGate {
  constructor(private on = false) {}
  set(on: boolean): void {
    this.on = on;
  }
  async enabled(): Promise<boolean> {
    return this.on;
  }
}

/** Uncached by construction: reads the live map on every call. */
export class InMemoryConsentReader implements ConsentReader {
  private readonly granted = new Map<string, boolean>();
  set(userId: string, granted: boolean): void {
    this.granted.set(userId, granted);
  }
  async analyticsConsent(userId: string): Promise<boolean> {
    return this.granted.get(userId) === true;
  }
}

/** Accepts tokens `ok:<anything>`; everything else is invalid. A fake, never wired in production. */
export class FakeAttestationCheck implements AttestationCheck {
  async verify(_platform: "ios" | "android", token: string): Promise<AttestationVerdictLite> {
    return token.startsWith("ok:") ? { ok: true } : { ok: false, reason: "invalid_token" };
  }
}

export class InMemoryPlausibilityStore implements PlausibilityStore {
  private readonly keys = new Map<string, number>();
  private readonly counters = new Map<string, { total: number; resetAtMs: number }>();
  down = false;
  constructor(private readonly nowMs: () => number) {}
  private check(): void {
    if (this.down) throw new PlausibilityUnavailableError();
  }
  async setIfAbsent(key: string, ttlSeconds: number): Promise<boolean> {
    this.check();
    const now = this.nowMs();
    const exp = this.keys.get(key);
    if (exp !== undefined && exp > now) return false;
    this.keys.set(key, now + ttlSeconds * 1000);
    return true;
  }
  async addToWindow(key: string, windowSeconds: number, by: number): Promise<number> {
    this.check();
    const now = this.nowMs();
    const c = this.counters.get(key);
    if (c === undefined || c.resetAtMs <= now) {
      this.counters.set(key, { total: by, resetAtMs: now + windowSeconds * 1000 });
      return by;
    }
    c.total += by;
    return c.total;
  }
  async release(keys: readonly string[]): Promise<void> {
    for (const k of keys) this.keys.delete(k);
  }
}

export class InMemoryBatchOutbox implements BatchOutbox {
  readonly rows: AnalyticsOutboxDraft[] = [];
  failNext = false;
  async append(draft: AnalyticsOutboxDraft): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("outbox down");
    }
    this.rows.push(draft);
  }
}

export class StaticVocabulary implements TermVocabulary {
  constructor(private readonly words: ReadonlySet<string>) {}
  async allKnown(tokens: readonly string[]): Promise<boolean> {
    return tokens.every((t) => this.words.has(t));
  }
}

export class RecordingCounters implements IngestCounters {
  readonly counts = new Map<string, number>();
  inc(reason: string, by = 1): void {
    this.counts.set(reason, (this.counts.get(reason) ?? 0) + by);
  }
  get(reason: string): number {
    return this.counts.get(reason) ?? 0;
  }
}

/** Deterministic non-cryptographic keyer for tests only. */
export class FakeKeyer implements ShopperKeyer {
  shopperKey(userId: string): string {
    return Buffer.from(`sk:${userId}`).toString("hex").padEnd(64, "0").slice(0, 64);
  }
  termHash(term: string): string {
    return Buffer.from(`th:${term}`).toString("hex").padEnd(64, "0").slice(0, 64);
  }
}
