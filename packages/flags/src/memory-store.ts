import { assertNoKillSwitchRules } from "./kill-switches.js";
import type { FlagRecord, FlagStore, FlagWrite } from "./types.js";

const k = (key: string, marketId: string | null): string => `${key}\u0000${marketId ?? ""}`;

export class InMemoryFlagStore implements FlagStore {
  private readonly rows = new Map<string, FlagRecord>();
  /** Test hook: make every call reject. */
  failWith: Error | undefined;
  calls = 0;

  get(key: string, marketId: string): Promise<readonly FlagRecord[]> {
    this.calls += 1;
    if (this.failWith) return Promise.reject(this.failWith);
    const out = [this.rows.get(k(key, null)), this.rows.get(k(key, marketId))].filter((r): r is FlagRecord => r !== undefined);
    return Promise.resolve(out);
  }

  list(): Promise<readonly FlagRecord[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    return Promise.resolve([...this.rows.values()]);
  }

  put(w: FlagWrite): Promise<{ before: FlagRecord | undefined; after: FlagRecord }> {
    try {
      assertNoKillSwitchRules(w.key, w.rules);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    if (this.failWith) return Promise.reject(this.failWith);
    const before = this.rows.get(k(w.key, w.marketId));
    const after: FlagRecord = {
      key: w.key,
      marketId: w.marketId,
      enabled: w.enabled,
      rules: w.rules ?? {},
      version: (before?.version ?? 0) + 1,
      updatedBy: w.updatedBy,
      updatedAt: w.updatedAt,
    };
    this.rows.set(k(w.key, w.marketId), after);
    return Promise.resolve({ before, after });
  }
}
