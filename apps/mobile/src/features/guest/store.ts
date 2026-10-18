/**
 * GuestStore: synchronous reads from a cached snapshot, async persistence behind a GuestStorageAdapter.
 * No server calls. Never throws on storage failure: corrupt, oversized or unreadable data is dropped and recreated
 * (E8), a newer schema gives a read-only empty view and the stored data is left untouched.
 */
import { randomUrlSafeId } from "../../platform/random";
import { migrate } from "./migrate";
import {
  addBagLine, bumpAffinity, emptyState, purgeExpired, recordView, removeBagLine, saveItem, setBanner, setBagQty,
  setMergePending, setSavedForLater, setSettings, unsaveItem, unwatchAlert, watchAlert, type GuestError, type Mutation, type NewBagLine,
} from "./model";
import { MAX_STATE_BYTES, type AlertKind, type BannerState, type GuestAlert, type GuestBagLine, type GuestState, type SavedIntent } from "./schema";
import type { GuestStorageAdapter } from "./storage";

export type ResetCause = "corrupt" | "too_large" | "newer" | "open_failed";
export type GuestResult = { readonly ok: true } | { readonly ok: false; readonly error: GuestError };

export interface GuestStoreOptions {
  readonly now?: () => number;
  readonly newLineId?: () => string;
}

export interface AddToBagInput {
  readonly skuId: string; readonly productId: string; readonly storeId: string; readonly qty: number; readonly seen: GuestBagLine["seen"];
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

export class GuestStore {
  private state: GuestState;
  private readOnly = false;
  private hydrated: Promise<void> | null = null;
  private reset: ResetCause | null = null;
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  private persistFailed = false;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly newLineId: () => string;

  constructor(private readonly adapter: GuestStorageAdapter, opts: GuestStoreOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.newLineId = opts.newLineId ?? (() => `gl_${randomUrlSafeId(16)}`);
    this.state = emptyState(this.now());
  }

  /** Loads, validates, migrates and purges. Safe to call many times. */
  hydrate(): Promise<void> {
    if (this.hydrated === null) this.hydrated = this.load();
    return this.hydrated;
  }

  private async load(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.adapter.read();
    } catch {
      this.reset = "open_failed";
      this.persistFailed = true;
      return;
    }
    if (raw === null) { this.schedule(); return; }
    if (byteLength(raw) > MAX_STATE_BYTES) return this.recreate("too_large");
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return this.recreate("corrupt"); }
    const m = migrate(parsed);
    if (m.kind === "invalid") return this.recreate("corrupt");
    if (m.kind === "newer") {
      this.readOnly = true;
      this.reset = "newer";
      this.state = emptyState(this.now());
      return;
    }
    // Local edits made before hydrate finished are not lost: only replace when nothing changed yet.
    this.state = purgeExpired(m.state, this.now());
    if (m.migrated || this.state !== m.state) this.schedule();
    this.emit();
  }

  private async recreate(cause: ResetCause): Promise<void> {
    this.reset = cause;
    this.state = emptyState(this.now());
    try { await this.adapter.clear(); } catch { this.persistFailed = true; }
    this.schedule();
    this.emit();
  }

  // ---- reads (synchronous) ----
  getState(): GuestState { return this.state; }
  isReadOnly(): boolean { return this.readOnly; }
  /** False after a storage failure: the bag still works for this session but will not survive a restart. */
  isPersisting(): boolean { return !this.persistFailed; }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  /** One-time notice for the UI ("we had to reset your saved items on this phone"). Returns the cause once. */
  consumeResetNotice(): ResetCause | null { const c = this.reset; this.reset = null; return c; }

  // ---- writes ----
  addToBag(input: AddToBagInput): GuestResult {
    const line: NewBagLine = { id: this.newLineId(), ...input };
    return this.apply(addBagLine(this.state, line, this.now()), input.storeId);
  }
  setQty(lineId: string, qty: number): GuestResult { return this.apply(setBagQty(this.state, lineId, qty, this.now())); }
  removeLine(lineId: string): GuestResult { return this.apply(removeBagLine(this.state, lineId, this.now())); }
  setLineSavedForLater(lineId: string, saved: boolean): GuestResult { return this.apply(setSavedForLater(this.state, lineId, saved, this.now())); }
  save(item: { productId: string; skuId: string | null; intent: SavedIntent; seenPricePiastres: string }): GuestResult {
    return this.commit(saveItem(this.state, item, this.now()));
  }
  unsave(productId: string, intent: SavedIntent | null = null): GuestResult { return this.commit(unsaveItem(this.state, productId, intent, this.now())); }
  /** No-op while history is paused. */
  view(productId: string): GuestResult { if (this.state.settings.historyPaused) return { ok: true }; return this.commit(recordView(this.state, productId, this.now())); }
  /** "Clear history on this phone": recently viewed and the device-only affinity counters. Bag and Saved stay. */
  clearHistory(): GuestResult { return this.commit({ ...this.state, viewed: [], affinity: { stores: {}, categories: {} }, updatedAt: this.now() }); }
  /** Local "Notify me". Stays on the device: the guest-merge body has no alerts field until a server route accepts it. */
  watch(a: { productId: string; skuId?: string | null; kind: AlertKind; seenPricePiastres?: string | null }): GuestResult { return this.commit(watchAlert(this.state, a, this.now())); }
  unwatch(productId: string, kind: AlertKind): GuestResult { return this.commit(unwatchAlert(this.state, productId, kind, this.now())); }
  watches(): readonly GuestAlert[] { return this.state.alerts; }
  like(kind: "stores" | "categories", key: string): GuestResult { if (this.state.settings.historyPaused) return { ok: true }; return this.commit(bumpAffinity(this.state, kind, key, this.now())); }
  /** Saved cool-off ("Remind me tomorrow") device setting. */
  setCoolOff(on: boolean): GuestResult { return this.commit(setSettings(this.state, { coolOff: on }, this.now())); }
  /** While paused, view() and affinity updates record nothing. Existing history stays until cleared. */
  setHistoryPaused(on: boolean): GuestResult { return this.commit(setSettings(this.state, { historyPaused: on }, this.now())); }
  setConsentBanner(b: BannerState): GuestResult { return this.commit(setBanner(this.state, b, this.now())); }
  setMergePending(key: string | null): GuestResult { return this.commit(setMergePending(this.state, key, this.now())); }

  /** Merge outcome: only a 200 clears pendingKey and the merged items; any other status keeps the key for the retry. */
  completeMerge(status: number, lineIds: readonly string[], savedKeys: readonly { productId: string; intent: SavedIntent }[] = [], viewedIds: readonly string[] = []): GuestResult {
    if (status !== 200) return { ok: true };
    const r = this.removeMerged(lineIds, savedKeys, viewedIds);
    return r.ok ? this.setMergePending(null) : r;
  }

  /** Removes bag lines that were merged (only the ones sent, spec §3). Lines added during the request survive. */
  removeMerged(lineIds: readonly string[], savedKeys: readonly { productId: string; intent: SavedIntent }[] = [], viewedIds: readonly string[] = []): GuestResult {
    const vset = new Set(viewedIds);
    const ids = new Set(lineIds);
    const keys = new Set(savedKeys.map((k) => `${k.intent}:${k.productId}`));
    return this.commit({
      ...this.state,
      bag: this.state.bag.filter((l) => !ids.has(l.id)),
      saved: this.state.saved.filter((x) => !keys.has(`${x.intent}:${x.productId}`)),
      viewed: this.state.viewed.filter((v) => !vset.has(v.productId)),
      updatedAt: this.now(),
    });
  }

  /** "Clear data on this phone" / under-18 wipe: drops the stored data. */
  async clearAll(): Promise<void> {
    this.state = emptyState(this.now());
    this.dirty = false;
    await this.writing;
    try { await this.adapter.clear(); } catch { this.persistFailed = true; }
    this.emit();
  }

  /** Resolves when every accepted change has reached the adapter (tests, app backgrounding). */
  async flush(): Promise<void> {
    await this.hydrate();
    let w: Promise<void>;
    do { w = this.writing; await w; } while (w !== this.writing);
  }

  private apply(m: Mutation, affinityStore?: string): GuestResult {
    if (this.readOnly) return { ok: false, error: "read_only" };
    if (!m.ok) return { ok: false, error: m.error };
    const next = affinityStore === undefined || this.state.settings.historyPaused ? m.state : bumpAffinity(m.state, "stores", affinityStore, this.now());
    return this.commit(next);
  }

  private commit(next: GuestState): GuestResult {
    if (this.readOnly) return { ok: false, error: "read_only" };
    this.state = next;
    this.schedule();
    this.emit();
    return { ok: true };
  }

  private emit(): void { for (const l of [...this.listeners]) l(); }

  private schedule(): void {
    if (this.readOnly) return;
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await this.hydrate().catch(() => undefined);
      let json = JSON.stringify(this.state);
      if (byteLength(json) > MAX_STATE_BYTES) {
        // Memory and disk must not diverge: truncate the live state too and tell the UI once.
        this.state = { ...this.state, viewed: [], saved: this.state.saved.slice(-50) };
        this.reset = "too_large";
        json = JSON.stringify(this.state);
        this.emit();
      }
      try { await this.adapter.write(json); this.persistFailed = false; } catch { this.persistFailed = true; }
    });
  }
}
