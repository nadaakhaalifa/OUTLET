/**
 * Thin expo-sqlite adapter (Expo Go compatible, SDK 57 "Included in Expo Go"). Not encrypted (spec §5).
 * The real module cannot run under vitest; the adapter takes an injected opener and is contract-tested with a fake DB.
 */
import type { GuestStorageAdapter } from "./storage";

export interface SqliteDb {
  execAsync(source: string): Promise<void>;
  runAsync(source: string, ...params: (string | number)[]): Promise<unknown>;
  getFirstAsync<T>(source: string, ...params: (string | number)[]): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
  closeAsync(): Promise<void>;
}
export interface SqliteOpener {
  open(name: string): Promise<SqliteDb>;
  destroy(name: string): Promise<void>;
}

export const GUEST_DB_NAME = "outlet-guest.db";

/** The only place expo-sqlite is imported (lazily, so tests and non-guest code never load it). */
export const expoSqliteOpener: SqliteOpener = {
  async open(name) { const m = await import("expo-sqlite"); return m.openDatabaseAsync(name); },
  async destroy(name) { const m = await import("expo-sqlite"); await m.deleteDatabaseAsync(name); },
};

export class SqliteGuestStorage implements GuestStorageAdapter {
  private db: Promise<SqliteDb> | null = null;
  constructor(private readonly opener: SqliteOpener = expoSqliteOpener, private readonly now: () => number = Date.now) {}

  private open(): Promise<SqliteDb> {
    if (this.db === null) {
      this.db = this.opener.open(GUEST_DB_NAME).then(async (d) => {
        await d.execAsync("CREATE TABLE IF NOT EXISTS guest_state (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL)");
        return d;
      });
      this.db.catch(() => { this.db = null; });
    }
    return this.db;
  }

  async read(): Promise<string | null> {
    const row = await (await this.open()).getFirstAsync<{ v: string }>("SELECT v FROM guest_state WHERE k = ?", "state");
    return row === null ? null : row.v;
  }

  async write(json: string): Promise<void> {
    const d = await this.open();
    await d.withTransactionAsync(async () => {
      await d.runAsync("INSERT OR REPLACE INTO guest_state (k, v, updated_at) VALUES (?, ?, ?)", "state", json, this.now());
    });
  }

  async clear(): Promise<void> {
    const pending = this.db;
    this.db = null;
    if (pending !== null) await pending.then((d) => d.closeAsync()).catch(() => undefined);
    await this.opener.destroy(GUEST_DB_NAME);
  }
}
