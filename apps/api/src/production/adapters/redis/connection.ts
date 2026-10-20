import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { RedisConfig } from "./config";

/** Thrown by every Redis adapter when Redis cannot answer. Callers choose fail-open or fail-closed. */
export class RedisUnavailableError extends Error {
  constructor(readonly reason: "connect" | "command" | "breaker_open" | "closed", cause?: unknown) {
    super(`redis unavailable (${reason})`, cause === undefined ? undefined : { cause });
    this.name = "RedisUnavailableError";
  }
}

/** The small surface the adapters use. ioredis and ioredis-mock both satisfy it (cast at the factory). */
export interface RedisClient {
  readonly status: string;
  connect(): Promise<void>;
  ping(): Promise<string>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ...args: (string | number)[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  hset(key: string, ...fieldValues: string[]): Promise<number>;
  defineCommand(name: string, def: { numberOfKeys: number; lua: string }): void;
  quit(): Promise<unknown>;
  disconnect(): void;
  on(event: string, listener: (...a: never[]) => void): unknown;
}

/** Plain counters; the process metrics sink can scrape `snapshot()`. */
export class RedisStats {
  private readonly c = new Map<string, number>();
  inc(name: string, by = 1): void {
    this.c.set(name, (this.c.get(name) ?? 0) + by);
  }
  get(name: string): number {
    return this.c.get(name) ?? 0;
  }
  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.c);
  }
}

export interface BreakerOptions {
  /** Consecutive failures that open the breaker. */
  readonly threshold: number;
  /** How long it stays open (calls fail immediately), then one probe is allowed. */
  readonly openMs: number;
}
const DEFAULT_BREAKER: BreakerOptions = { threshold: 3, openMs: 1000 };

/** First 32 hex chars of sha256: keys never contain a user id, device id or IP in clear. */
export function keyHash(label: string, value: string): string {
  return createHash("sha256").update(`${label}\u0000${value}`).digest("hex").slice(0, 32);
}

/**
 * One Redis connection plus a circuit breaker. A refused or timed-out command counts as a failure;
 * after `threshold` consecutive failures calls fail instantly for `openMs` so an outage cannot pile
 * latency onto checkout. Never throws anything but RedisUnavailableError.
 */
export class RedisConnection {
  readonly stats = new RedisStats();
  private failures = 0;
  private openUntil = 0;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private readonly registered = new Set<string>();

  constructor(
    readonly client: RedisClient,
    readonly keyPrefix: string,
    private readonly nowMs: () => number = Date.now,
    private readonly breaker: BreakerOptions = DEFAULT_BREAKER,
  ) {}

  /** Lazy: nothing connects until the first command. */
  static fromConfig(cfg: RedisConfig, nowMs: () => number = Date.now): RedisConnection {
    const client = new Redis(cfg.url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: cfg.connectTimeoutMs,
      commandTimeout: cfg.commandTimeoutMs,
      retryStrategy: (times: number): number => Math.min(times * 200, 5000),
      ...(cfg.tls ? { tls: {} } : {}),
    });
    // An unhandled 'error' event would crash the process; the breaker already records failures.
    client.on("error", () => undefined);
    return new RedisConnection(client as unknown as RedisClient, cfg.keyPrefix, nowMs);
  }

  key(...parts: string[]): string {
    return [this.keyPrefix, ...parts].join(":");
  }

  /** Runs one operation under the breaker. */
  async exec<T>(op: string, fn: (c: RedisClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new RedisUnavailableError("closed");
    const now = this.nowMs();
    if (this.failures >= this.breaker.threshold && now < this.openUntil) {
      this.stats.inc("redis.breaker_rejected");
      throw new RedisUnavailableError("breaker_open");
    }
    try {
      await this.ensureConnected();
      const out = await fn(this.client);
      this.failures = 0;
      this.stats.inc(`redis.ok.${op}`);
      return out;
    } catch (e) {
      this.failures += 1;
      if (this.failures >= this.breaker.threshold) this.openUntil = this.nowMs() + this.breaker.openMs;
      this.stats.inc(`redis.error.${op}`);
      throw e instanceof RedisUnavailableError ? e : new RedisUnavailableError("command", e);
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.status !== "wait") return;
    this.connecting ??= this.client.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
  }

  /** Registers a Lua script once and returns a caller. KEYS then ARGV, all strings. */
  script(name: string, lua: string, numberOfKeys: number): (keys: readonly string[], args: readonly (string | number)[]) => Promise<unknown> {
    if (!this.registered.has(name)) {
      this.client.defineCommand(name, { numberOfKeys, lua });
      this.registered.add(name);
    }
    const fn = (this.client as unknown as Record<string, unknown>)[name];
    if (typeof fn !== "function") throw new Error(`redis script ${name} was not registered`);
    const call = fn as (...a: (string | number)[]) => Promise<unknown>;
    return (keys, args) => this.exec(`lua.${name}`, () => call.apply(this.client, [...keys, ...args]));
  }

  /** true when PING answers. Never throws; bypasses nothing: an open breaker reports unreachable. */
  async ping(): Promise<boolean> {
    try {
      return (await this.exec("ping", (c) => c.ping())) === "PONG";
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect();
    }
  }
}
