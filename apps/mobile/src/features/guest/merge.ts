/**
 * Guest-to-account merge client (spec guest-browsing §3, ADR-0055). Runs after sign-up at the Checkout gate.
 *
 * Key handling: the UUIDv7 Idempotency-Key is written to the device store (`setMergePending`) and flushed BEFORE the
 * request, reused on every retry of the same attempt and cleared only by a 200. Only the items that were sent are
 * removed on success, so lines added while the request was in flight survive. A non-200 never deletes anything.
 * One exception: 422 means the same key met a different body (the bag changed between attempts); the merge is
 * idempotent by rule (larger quantity wins), so one fresh key is safe and is tried once.
 */
import type { schemas } from "../../services/api-client";
import { MAX_BAG_LINES, MAX_UNITS_PER_ITEM, type GuestState, type SavedIntent } from "./schema";
import type { GuestStorePort } from "./port";

export type MergeHttpResult =
  | { readonly status: 200; readonly data: schemas.GuestMergeResponse }
  | { readonly status: number; readonly data: null };

/** Never throws: a network failure or timeout is status 0. */
export interface MergeTransport {
  merge(body: schemas.GuestMergeRequest, idempotencyKey: string): Promise<MergeHttpResult>;
}

export type MergeNoteKind = "kept_larger" | "moved_to_saved" | "moved_to_bag" | "unavailable" | "store_suspended" | "clamped";
export interface MergeNote {
  readonly kind: MergeNoteKind;
  readonly title: string;
  /** Quantity on this phone, in the account before the merge (null if the account did not hold it) and the final quantity. */
  readonly localQty: number;
  readonly accountQty: number | null;
  readonly qty: number | null;
  readonly reason: "over_cap" | "unavailable" | null;
}
export interface MergeSummary {
  readonly notes: readonly MergeNote[];
  readonly savedOverCap: number;
  readonly savedUnavailable: number;
  /** True when anything the shopper should be told happened. False: go straight to Delivery. */
  readonly changed: boolean;
}

export type MergeOutcome =
  | { readonly kind: "nothing" }
  | { readonly kind: "done"; readonly summary: MergeSummary }
  | { readonly kind: "failed"; readonly status: number };

export interface MergeDeps {
  readonly store: GuestStorePort;
  readonly transport: MergeTransport;
  /** Fresh UUIDv7. */
  readonly newKey: () => string;
  /** Recently viewed is sent only with the `personalization` consent. */
  readonly includeViewed: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (s: string | null): s is string => s !== null && UUID.test(s);

export interface MergePayload {
  readonly body: schemas.GuestMergeRequest;
  readonly lineIds: readonly string[];
  readonly savedKeys: readonly { productId: string; intent: SavedIntent }[];
  readonly viewedIds: readonly string[];
  readonly localQty: ReadonlyMap<string, { readonly qty: number; readonly title: string }>;
}

/** Pure: what would be sent for this state. Entries whose ids are not UUIDs cannot be understood by the server and stay on the phone. */
export function buildMergePayload(s: GuestState, includeViewed: boolean): MergePayload {
  const lines = s.bag.filter((l) => isUuid(l.skuId)).slice(0, MAX_BAG_LINES);
  const saved = s.saved.filter((x) => isUuid(x.productId));
  const viewed = includeViewed ? s.viewed.filter((v) => isUuid(v.productId)) : [];
  const body: schemas.GuestMergeRequest = {
    ...(lines.length > 0 ? { bag_lines: lines.map((l) => ({ sku_id: l.skuId, qty: Math.min(MAX_UNITS_PER_ITEM, l.qty), saved_for_later: l.savedForLater, added_at: new Date(l.addedAt).toISOString() })) } : {}),
    ...(saved.length > 0 ? { saved: saved.map((x) => ({ product_id: x.productId, ...(isUuid(x.skuId) ? { sku_id: x.skuId } : {}), intent: x.intent })) } : {}),
    ...(viewed.length > 0 ? { recently_viewed: viewed.map((v) => ({ product_id: v.productId, viewed_at: new Date(v.at).toISOString() })) } : {}),
  };
  return {
    body,
    lineIds: lines.map((l) => l.id),
    savedKeys: saved.map((x) => ({ productId: x.productId, intent: x.intent })),
    viewedIds: viewed.map((v) => v.productId),
    localQty: new Map(lines.map((l) => [l.skuId, { qty: l.qty, title: l.seen.title }])),
  };
}

export function hasMergeWork(s: GuestState, includeViewed = false): boolean {
  const p = buildMergePayload(s, includeViewed);
  return p.lineIds.length > 0 || p.savedKeys.length > 0 || p.viewedIds.length > 0;
}

/** Pure: turns the server outcome into what the shopper is told. Numbers and titles only. */
export function summarizeMerge(res: schemas.GuestMergeResponse, local: MergePayload["localQty"]): MergeSummary {
  const notes: MergeNote[] = [];
  for (const l of res.outcome.lines) {
    const mine = local.get(l.sku_id);
    if (mine === undefined) continue;
    const base = { title: mine.title, localQty: mine.qty, accountQty: l.previous_qty, qty: l.qty, reason: l.reason };
    if ((l.result === "qty_raised" || l.result === "unchanged") && l.previous_qty !== null && l.previous_qty !== mine.qty) notes.push({ kind: "kept_larger", ...base });
    else if (l.result === "moved_to_saved") notes.push({ kind: "moved_to_saved", ...base });
    else if (l.result === "moved_to_bag") notes.push({ kind: "moved_to_bag", ...base });
    else if (l.result === "unavailable") notes.push({ kind: "unavailable", ...base });
    else if (l.result === "store_suspended") notes.push({ kind: "store_suspended", ...base });
    else if (l.result === "limit_clamped") notes.push({ kind: "clamped", ...base });
  }
  const { over_cap: savedOverCap, unavailable: savedUnavailable } = res.outcome.saved;
  return { notes, savedOverCap, savedUnavailable, changed: notes.length > 0 || savedOverCap > 0 || savedUnavailable > 0 };
}

const inFlight = new WeakMap<GuestStorePort, Promise<MergeOutcome>>();

/** One merge per store at a time (the Bag reload and the gate can both ask). Safe to call repeatedly: a retry reuses the stored key. */
export function runGuestMerge(deps: MergeDeps): Promise<MergeOutcome> {
  const running = inFlight.get(deps.store);
  if (running !== undefined) return running;
  const p = attempt(deps, false).finally(() => { inFlight.delete(deps.store); });
  inFlight.set(deps.store, p);
  return p;
}

async function attempt(deps: MergeDeps, rotated: boolean): Promise<MergeOutcome> {
  const { store, transport } = deps;
  await store.hydrate();
  if (store.isReadOnly()) return { kind: "nothing" };
  const payload = buildMergePayload(store.getState(), deps.includeViewed);
  if (payload.lineIds.length === 0 && payload.savedKeys.length === 0 && payload.viewedIds.length === 0) {
    if (store.getState().merge.pendingKey !== null) store.setMergePending(null);
    return { kind: "nothing" };
  }
  let key = store.getState().merge.pendingKey;
  if (key === null) {
    key = deps.newKey();
    store.setMergePending(key);
  }
  await store.flush().catch(() => undefined); // the key is on disk before the request leaves the phone (in memory if the disk fails)
  const res = await transport.merge(payload.body, key);
  if (res.status === 200 && res.data !== null) {
    const summary = summarizeMerge(res.data, payload.localQty);
    store.completeMerge(200, payload.lineIds, payload.savedKeys, res.data.outcome.viewed === "accepted" ? payload.viewedIds : []);
    await store.flush().catch(() => undefined); // the merge succeeded; a failed disk write must not turn it into an error
    return { kind: "done", summary };
  }
  if (res.status === 422 && !rotated) {
    store.setMergePending(null);
    return attempt(deps, true);
  }
  return { kind: "failed", status: res.status };
}
