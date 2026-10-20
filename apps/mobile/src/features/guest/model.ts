/** Pure guest model: caps, TTL, dedupe, affinity and the merge plan. No I/O, no clock (callers pass `now`). */
import {
  MAX_AFFINITY_KEYS, MAX_ALERTS, MAX_BAG_LINES, MAX_SAVED, MAX_UNITS_PER_ITEM, MAX_VIEWED, TTL_MS,
  type AlertKind, type BannerState, type GuestBagLine, type GuestState, type SavedIntent,
} from "./schema";

export function emptyState(now: number): GuestState {
  return {
    v: 4, createdAt: now, updatedAt: now, bag: [], saved: [], viewed: [], alerts: [], settings: { coolOff: false, historyPaused: false },
    affinity: { stores: {}, categories: {} }, merge: { pendingKey: null, startedAt: null },
    consentBanner: "unanswered",
  };
}

export type GuestError = "lines_cap" | "units_cap" | "not_found" | "read_only";
export type Mutation = { readonly ok: true; readonly state: GuestState } | { readonly ok: false; readonly error: GuestError; readonly state: GuestState };

export interface NewBagLine {
  readonly id: string;
  readonly skuId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly qty: number;
  readonly seen: GuestBagLine["seen"];
}

const touch = (s: GuestState, now: number): GuestState => ({ ...s, updatedAt: now });

/** Adds qty to the line for the same SKU (dedupe) or creates one. Refuses past 50 lines or 10 units (E13). */
export function addBagLine(s: GuestState, input: NewBagLine, now: number): Mutation {
  const existing = s.bag.find((l) => l.skuId === input.skuId);
  if (existing !== undefined) {
    const qty = existing.qty + input.qty;
    if (qty > MAX_UNITS_PER_ITEM) return { ok: false, error: "units_cap", state: s };
    const bag = s.bag.map((l) => (l === existing ? { ...l, qty, touchedAt: now, seen: input.seen } : l));
    return { ok: true, state: touch({ ...s, bag }, now) };
  }
  if (input.qty > MAX_UNITS_PER_ITEM) return { ok: false, error: "units_cap", state: s };
  if (s.bag.length >= MAX_BAG_LINES) return { ok: false, error: "lines_cap", state: s };
  const line: GuestBagLine = { id: input.id, skuId: input.skuId, productId: input.productId, storeId: input.storeId, qty: input.qty, savedForLater: false, addedAt: now, touchedAt: now, seen: input.seen };
  return { ok: true, state: touch({ ...s, bag: [...s.bag, line] }, now) };
}

export function setBagQty(s: GuestState, lineId: string, qty: number, now: number): Mutation {
  const line = s.bag.find((l) => l.id === lineId);
  if (line === undefined) return { ok: false, error: "not_found", state: s };
  if (qty <= 0) return removeBagLine(s, lineId, now);
  if (qty > MAX_UNITS_PER_ITEM) return { ok: false, error: "units_cap", state: s };
  return { ok: true, state: touch({ ...s, bag: s.bag.map((l) => (l === line ? { ...l, qty, touchedAt: now } : l)) }, now) };
}

export function removeBagLine(s: GuestState, lineId: string, now: number): Mutation {
  if (!s.bag.some((l) => l.id === lineId)) return { ok: false, error: "not_found", state: s };
  return { ok: true, state: touch({ ...s, bag: s.bag.filter((l) => l.id !== lineId) }, now) };
}

export function setSavedForLater(s: GuestState, lineId: string, saved: boolean, now: number): Mutation {
  const line = s.bag.find((l) => l.id === lineId);
  if (line === undefined) return { ok: false, error: "not_found", state: s };
  return { ok: true, state: touch({ ...s, bag: s.bag.map((l) => (l === line ? { ...l, savedForLater: saved, touchedAt: now } : l)) }, now) };
}

/** Dedupe key is (intent, productId). Re-saving refreshes the entry. Oldest entry is evicted past 200. */
export function saveItem(s: GuestState, item: { productId: string; skuId: string | null; intent: SavedIntent; seenPricePiastres: string }, now: number): GuestState {
  const rest = s.saved.filter((x) => !(x.productId === item.productId && x.intent === item.intent));
  const saved = [...rest, { ...item, addedAt: now }].slice(-MAX_SAVED);
  return touch({ ...s, saved }, now);
}

export function unsaveItem(s: GuestState, productId: string, intent: SavedIntent | null, now: number): GuestState {
  return touch({ ...s, saved: s.saved.filter((x) => !(x.productId === productId && (intent === null || x.intent === intent))) }, now);
}

/** Dedupe key is (productId, kind); re-watching refreshes. Oldest evicted past 100. */
export function watchAlert(s: GuestState, a: { productId: string; skuId?: string | null; kind: AlertKind; seenPricePiastres?: string | null }, now: number): GuestState {
  const rest = s.alerts.filter((x) => !(x.productId === a.productId && x.kind === a.kind));
  const alerts = [...rest, { productId: a.productId, skuId: a.skuId ?? null, kind: a.kind, seenPricePiastres: a.seenPricePiastres ?? null, addedAt: now }].slice(-MAX_ALERTS);
  return touch({ ...s, alerts }, now);
}

export function unwatchAlert(s: GuestState, productId: string, kind: AlertKind, now: number): GuestState {
  return touch({ ...s, alerts: s.alerts.filter((x) => !(x.productId === productId && x.kind === kind)) }, now);
}

/** Most recent first, deduped by product, max 100. */
export function recordView(s: GuestState, productId: string, now: number): GuestState {
  const viewed = [{ productId, at: now }, ...s.viewed.filter((v) => v.productId !== productId)].slice(0, MAX_VIEWED);
  return touch({ ...s, viewed }, now);
}

function bump(rec: Record<string, number>, key: string): Record<string, number> {
  const next = { ...rec, [key]: (rec[key] ?? 0) + 1 };
  const keys = Object.keys(next);
  if (keys.length <= MAX_AFFINITY_KEYS) return next;
  const lowest = keys.filter((k) => k !== key).sort((a, b) => (next[a] ?? 0) - (next[b] ?? 0) || a.localeCompare(b))[0];
  if (lowest !== undefined) delete next[lowest];
  return next;
}

export function bumpAffinity(s: GuestState, kind: "stores" | "categories", key: string, now: number): GuestState {
  return touch({ ...s, affinity: { ...s.affinity, [kind]: bump(s.affinity[kind], key) } }, now);
}

export function setSettings(s: GuestState, patch: Partial<GuestState["settings"]>, now: number): GuestState {
  return touch({ ...s, settings: { ...s.settings, ...patch } }, now);
}

export function setBanner(s: GuestState, banner: BannerState, now: number): GuestState {
  return touch({ ...s, consentBanner: banner }, now);
}

export function setMergePending(s: GuestState, pendingKey: string | null, now: number): GuestState {
  return touch({ ...s, merge: { pendingKey, startedAt: pendingKey === null ? null : now } }, now);
}

/** An entry is kept while age <= TTL and dropped once age > TTL (exactly TTL old is still kept). */
const alive = (ts: number, ttl: number, now: number): boolean => now - ts <= ttl;

export function purgeExpired(s: GuestState, now: number): GuestState {
  const bag = s.bag.filter((l) => alive(l.touchedAt, TTL_MS.bag, now));
  const saved = s.saved.filter((x) => alive(x.addedAt, TTL_MS.saved, now));
  const viewed = s.viewed.filter((v) => alive(v.at, TTL_MS.viewed, now));
  const alerts = s.alerts.filter((x) => alive(x.addedAt, TTL_MS.alerts, now));
  if (bag.length === s.bag.length && saved.length === s.saved.length && viewed.length === s.viewed.length && alerts.length === s.alerts.length) return s;
  return { ...s, bag, saved, viewed, alerts, updatedAt: now };
}

// ---- merge plan (mirrors the server rule, spec §3) ----

export interface MergeLine { readonly skuId: string; readonly qty: number }
export type MergeResult = "added" | "qty_raised" | "unchanged" | "over_cap";
export interface MergePlanLine { readonly skuId: string; readonly qty: number; readonly result: MergeResult }

/**
 * Union by skuId; quantity is the LARGER of local and server (never the sum), clamped to 10. Active lines cap at 50:
 * server lines always win, overflow local lines are returned as `over_cap` (they go to Saved). Pure and idempotent:
 * planMerge(local, resultLines) changes nothing.
 */
export function planMerge(local: readonly MergeLine[], server: readonly MergeLine[]): { readonly lines: readonly MergePlanLine[]; readonly overCap: readonly string[] } {
  const clamp = (q: number): number => Math.max(1, Math.min(MAX_UNITS_PER_ITEM, Math.trunc(q)));
  const out = new Map<string, MergePlanLine>();
  for (const s of server) {
    const prev = out.get(s.skuId);
    out.set(s.skuId, { skuId: s.skuId, qty: Math.max(prev?.qty ?? 0, clamp(s.qty)), result: "unchanged" });
  }
  const overCap: string[] = [];
  const seenLocal = new Set<string>();
  for (const l of local) {
    if (seenLocal.has(l.skuId)) continue;
    seenLocal.add(l.skuId);
    const localQty = clamp(Math.max(...local.filter((x) => x.skuId === l.skuId).map((x) => x.qty)));
    const cur = out.get(l.skuId);
    if (cur !== undefined) {
      if (localQty > cur.qty) out.set(l.skuId, { skuId: l.skuId, qty: localQty, result: "qty_raised" });
    } else if (out.size >= MAX_BAG_LINES) {
      overCap.push(l.skuId);
    } else {
      out.set(l.skuId, { skuId: l.skuId, qty: localQty, result: "added" });
    }
  }
  return { lines: [...out.values()], overCap };
}
