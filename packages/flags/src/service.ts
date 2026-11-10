import { KILL_SWITCHES, assertNoKillSwitchRules } from "./kill-switches.js";
import type { KillSwitchName } from "./kill-switches.js";
import { matchesRules } from "./rollout.js";
import type { AuditPort, EvalContext, FlagRecord, FlagRules, FlagStore } from "./types.js";

export interface FlagServiceOptions {
  readonly store: FlagStore;
  readonly audit: AuditPort;
  /** Epoch ms clock; injectable for tests. */
  readonly now?: () => number;
  /** Fresh window. Default 5 s. */
  readonly ttlMs?: number;
  /** Beyond ttl, stale entries are served (and refreshed in the background) up to this age. Default 60 s. */
  readonly maxStaleMs?: number;
  readonly onError?: (err: unknown) => void;
}

interface Entry {
  records: readonly FlagRecord[];
  fetchedAt: number;
}

export class FlagService {
  private readonly cache = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Entry>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxStaleMs: number;

  constructor(private readonly opts: FlagServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 5_000;
    this.maxStaleMs = opts.maxStaleMs ?? 60_000;
  }

  private refresh(cacheKey: string, key: string, marketId: string): Promise<Entry> {
    const existing = this.inflight.get(cacheKey);
    if (existing) return existing;
    const p = this.opts.store
      .get(key, marketId)
      .then((records) => {
        const entry = { records, fetchedAt: this.now() };
        this.cache.set(cacheKey, entry);
        return entry;
      })
      .finally(() => {
        this.inflight.delete(cacheKey);
      });
    this.inflight.set(cacheKey, p);
    return p;
  }

  /** Cached read: fresh, or stale-while-revalidate, or a blocking fetch (which may throw). */
  private async records(key: string, marketId: string): Promise<readonly FlagRecord[]> {
    const cacheKey = `${key}\u0000${marketId}`;
    const hit = this.cache.get(cacheKey);
    const age = hit ? this.now() - hit.fetchedAt : Infinity;
    if (hit && age < this.ttlMs) return hit.records;
    if (hit && age < this.maxStaleMs) {
      this.refresh(cacheKey, key, marketId).catch((err: unknown) => this.opts.onError?.(err));
      return hit.records;
    }
    return (await this.refresh(cacheKey, key, marketId)).records;
  }

  private static decide(records: readonly FlagRecord[], key: string, ctx: EvalContext): boolean | undefined {
    const row = records.find((r) => r.marketId === ctx.marketId) ?? records.find((r) => r.marketId === null);
    if (!row) return undefined;
    return row.enabled && matchesRules(key, row.rules, ctx);
  }

  /** Ordinary flag. Unknown flag or store failure returns defaultValue. */
  async isEnabled(key: string, ctx: EvalContext, defaultValue = false): Promise<boolean> {
    try {
      return FlagService.decide(await this.records(key, ctx.marketId), key, ctx) ?? defaultValue;
    } catch (err) {
      this.opts.onError?.(err);
      return defaultValue;
    }
  }

  /**
   * True when the feature is killed. No row = allowed. Store unreachable (and no usable cache):
   * money switches fail CLOSED (killed), UI switches fail OPEN (allowed). See KILL_SWITCHES.
   */
  async isKilled(name: KillSwitchName, ctx: EvalContext): Promise<boolean> {
    try {
      const allowed = FlagService.decide(await this.records(name, ctx.marketId), name, ctx) ?? true;
      return !allowed;
    } catch (err) {
      this.opts.onError?.(err);
      return KILL_SWITCHES[name].failMode === "closed";
    }
  }

  async setFlag(input: { key: string; marketId?: string | null; enabled: boolean; rules?: FlagRules; actor: string }): Promise<FlagRecord> {
    return this.write("flag.set", input);
  }

  engageKillSwitch(name: KillSwitchName, actor: string, marketId: string | null = null): Promise<FlagRecord> {
    return this.write("kill_switch.engaged", { key: name, marketId, enabled: false, actor });
  }

  releaseKillSwitch(name: KillSwitchName, actor: string, marketId: string | null = null): Promise<FlagRecord> {
    return this.write("kill_switch.released", { key: name, marketId, enabled: true, actor });
  }

  /** Store write then audit. If audit throws the change stays applied (a kill must never be blocked by audit). */
  private async write(
    action: "flag.set" | "kill_switch.engaged" | "kill_switch.released",
    input: { key: string; marketId?: string | null; enabled: boolean; rules?: FlagRules; actor: string },
  ): Promise<FlagRecord> {
    assertNoKillSwitchRules(input.key, input.rules);
    const at = new Date(this.now());
    const marketId = input.marketId ?? null;
    const { before, after } = await this.opts.store.put({
      key: input.key,
      marketId,
      enabled: input.enabled,
      ...(input.rules ? { rules: input.rules } : {}),
      updatedBy: input.actor,
      updatedAt: at,
    });
    this.cache.clear();
    await this.opts.audit.record({
      actor: input.actor,
      action,
      target: input.key,
      marketId,
      before: before ? { enabled: before.enabled, rules: before.rules, version: before.version } : null,
      after: { enabled: after.enabled, rules: after.rules, version: after.version },
      at,
    });
    return after;
  }
}
