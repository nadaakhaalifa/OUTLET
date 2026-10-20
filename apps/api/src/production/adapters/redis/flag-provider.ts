import {
  isKnownFlag,
  type EvaluationContext,
  type FlagProvider,
  type ResolutionDetails,
} from "../../../../../../packages/feature-flags/src/index";
import type { RedisConnection } from "./connection";

/**
 * FlagProvider reading values from one Redis hash (`<prefix>:flags`, field = registry key, value
 * "true" | "false"). Polarity is unchanged (ADR-0028): true = capability allowed. The whole hash is
 * loaded in one HGETALL and cached locally for `ttlMs` (single-flight). When Redis is unreachable and the
 * cache is older than the TTL the provider answers PROVIDER_NOT_READY, so FlagClient returns the registry
 * default (false = blocked): a kill switch never silently stays open past one TTL of staleness.
 * A missing field is not an error: the registry default applies (reason DEFAULT).
 */
export class RedisFlagProvider implements FlagProvider {
  readonly metadata = { name: "redis" } as const;
  readonly runsOn = "server" as const;
  private cache: { readonly at: number; readonly values: Readonly<Record<string, string>> } | null = null;
  private loading: Promise<Readonly<Record<string, string>> | null> | null = null;

  constructor(
    private readonly conn: RedisConnection,
    private readonly ttlMs = 5000,
    private readonly nowMs: () => number = Date.now,
  ) {}

  private hashKey(): string {
    return this.conn.key("flags");
  }

  private async values(): Promise<Readonly<Record<string, string>> | null> {
    const now = this.nowMs();
    if (this.cache !== null && now - this.cache.at < this.ttlMs) return this.cache.values;
    this.loading ??= this.conn
      .exec("flags.load", (c) => c.hgetall(this.hashKey()))
      .then((v) => {
        this.cache = { at: this.nowMs(), values: v };
        return v;
      })
      .catch(() => {
        this.conn.stats.inc("flags.stale_dropped");
        this.cache = null;
        return null;
      })
      .finally(() => {
        this.loading = null;
      });
    return this.loading;
  }

  async resolveBooleanEvaluation(key: string, def: boolean, _c: EvaluationContext): Promise<ResolutionDetails<boolean>> {
    const v = await this.values();
    if (v === null) return { value: def, reason: "ERROR", errorCode: "PROVIDER_NOT_READY" };
    const raw = v[key];
    if (raw === undefined) return { value: def, reason: "DEFAULT" };
    if (raw === "true") return { value: true, reason: "STATIC" };
    if (raw === "false") return { value: false, reason: "STATIC" };
    return { value: def, reason: "ERROR", errorCode: "PARSE_ERROR" };
  }
  async resolveStringEvaluation(key: string, def: string, _c: EvaluationContext): Promise<ResolutionDetails<string>> {
    const v = await this.values();
    if (v === null) return { value: def, reason: "ERROR", errorCode: "PROVIDER_NOT_READY" };
    const raw = v[key];
    return raw === undefined ? { value: def, reason: "DEFAULT" } : { value: raw, reason: "STATIC" };
  }
  async resolveNumberEvaluation(key: string, def: number, _c: EvaluationContext): Promise<ResolutionDetails<number>> {
    const v = await this.values();
    if (v === null) return { value: def, reason: "ERROR", errorCode: "PROVIDER_NOT_READY" };
    const raw = v[key];
    if (raw === undefined) return { value: def, reason: "DEFAULT" };
    const n = Number(raw);
    return Number.isFinite(n) ? { value: n, reason: "STATIC" } : { value: def, reason: "ERROR", errorCode: "PARSE_ERROR" };
  }
}

/** Operator write path (the admin console's flag backend can wrap this; writes are audited by the caller). */
export class RedisFlagWriter {
  constructor(private readonly conn: RedisConnection) {}
  async set(key: string, value: boolean): Promise<void> {
    if (!isKnownFlag(key)) throw new RangeError("unknown flag key");
    await this.conn.exec("flags.set", (c) => c.hset(this.conn.key("flags"), key, value ? "true" : "false"));
  }
}
