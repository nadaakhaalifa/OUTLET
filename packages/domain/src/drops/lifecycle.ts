import { dropMachine, type DropEvent, type DropState } from "../state-machine/machines/drop";
import { EARLY_ACCESS_MS, HOUR_MS, type Drop, type DropItem, type FieldError, type LadderStep } from "./types";

export const MAX_ITEMS = 50;
export const MAX_LADDER_STEPS = 12;

/** Fields a draft is built from (what the seller controls). */
export type DropDraft = Pick<
  Drop,
  "type" | "title" | "startsAtMs" | "earlyAccessAtMs" | "endsAtMs" | "items" | "limits" | "ladder" | "mystery" | "admitPerSec"
>;

const isInt = (n: number): boolean => Number.isInteger(n);

/** Structural and per-type rules. Returns every problem, not just the first. */
export function validateDraft(d: DropDraft): readonly FieldError[] {
  const e: FieldError[] = [];
  const bad = (field: string, code: string): void => void e.push({ field, code });
  if (d.title.trim().length < 2 || d.title.length > 120) bad("title", "length");
  if (!isInt(d.startsAtMs) || !isInt(d.endsAtMs) || d.endsAtMs <= d.startsAtMs) bad("ends_at", "before_start");
  if (d.items.length === 0 || d.items.length > MAX_ITEMS) bad("items", "count");
  const seen = new Set<string>();
  d.items.forEach((it, i) => {
    if (seen.has(it.skuId)) bad(`items.${i}.sku_id`, "duplicate");
    seen.add(it.skuId);
    if (!isInt(it.stockCap) || it.stockCap < 1) bad(`items.${i}.stock_cap`, "min_1");
    if (it.pricePiastres <= 0n) bad(`items.${i}.price`, "positive");
  });
  if (!isInt(d.limits.perUser) || d.limits.perUser < 1 || d.limits.perUser > 10) bad("limits.per_user", "range");
  if (!isInt(d.limits.perDevice) || d.limits.perDevice < d.limits.perUser || d.limits.perDevice > 10) bad("limits.per_device", "range");
  if (!isInt(d.admitPerSec) || d.admitPerSec < 1 || d.admitPerSec > 5000) bad("admit_per_sec", "range");

  if (d.type === "members_only") {
    if (d.earlyAccessAtMs === null || d.earlyAccessAtMs >= d.startsAtMs) bad("early_access_at", "before_start");
    else if (d.startsAtMs - d.earlyAccessAtMs !== EARLY_ACCESS_MS) bad("early_access_at", "must_be_24h");
  } else if (d.earlyAccessAtMs !== null) bad("early_access_at", "members_only");

  if (d.type === "flash_hour" && d.endsAtMs - d.startsAtMs !== HOUR_MS) bad("ends_at", "flash_hour_is_60_min");

  if (d.type === "price_ladder") e.push(...validateLadder(d.ladder, d));
  else if (d.ladder.length > 0) bad("ladder", "price_ladder_only");

  if (d.type === "mystery_box") {
    const m = d.mystery;
    if (m === null) bad("mystery", "required");
    else if (m.minValuePiastres <= 0n || m.maxValuePiastres < m.minValuePiastres || m.guaranteedMinPiastres < m.minValuePiastres || m.guaranteedMinPiastres > m.maxValuePiastres)
      bad("mystery", "range");
  } else if (d.mystery !== null) bad("mystery", "mystery_box_only");
  return e;
}

/** A published ladder: first step at the start, strictly later steps, strictly falling prices. */
export function validateLadder(ladder: readonly LadderStep[], d: Pick<Drop, "startsAtMs" | "endsAtMs" | "items">): readonly FieldError[] {
  const e: FieldError[] = [];
  if (ladder.length < 2 || ladder.length > MAX_LADDER_STEPS) return [{ field: "ladder", code: "steps" }];
  const first = ladder[0];
  if (first === undefined || first.atMs !== d.startsAtMs) e.push({ field: "ladder.0.at", code: "must_start_at_start" });
  for (let i = 1; i < ladder.length; i++) {
    const p = ladder[i - 1];
    const c = ladder[i];
    if (p === undefined || c === undefined) continue;
    if (c.atMs <= p.atMs || c.atMs >= d.endsAtMs) e.push({ field: `ladder.${i}.at`, code: "order" });
    if (c.pricePiastres >= p.pricePiastres || c.pricePiastres <= 0n) e.push({ field: `ladder.${i}.price`, code: "must_fall" });
  }
  return e;
}

/**
 * Server-timed ladder price for a base price. The ladder holds the absolute price of the
 * first (index 0) item scale: every step is a ratio of the first step so that several SKUs
 * share one published schedule. Integer math only, floor division (never above the step).
 */
export function ladderPriceAt(ladder: readonly LadderStep[], basePiastres: bigint, nowMs: number): bigint {
  const first = ladder[0];
  if (first === undefined) return basePiastres;
  let step = first;
  for (const s of ladder) if (s.atMs <= nowMs) step = s;
  return (basePiastres * step.pricePiastres) / first.pricePiastres;
}

export interface EditPatch {
  readonly title?: string;
  readonly limits?: Drop["limits"];
  readonly items?: readonly DropItem[];
  readonly startsAtMs?: number;
  readonly endsAtMs?: number;
}

export type EditVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "price_locked" | "stock_lowered" | "sku_set_locked" | "schedule_locked" | "state_locked" };

/**
 * After SCHEDULED a seller cannot change price or lower stock, only raise stock (spec 16).
 * Adding or removing SKUs and moving the schedule are also locked: the waiting room and the
 * published ladder were built on them. Once the drop is running nothing is editable.
 */
export function checkEdit(current: Drop, patch: EditPatch): EditVerdict {
  if (current.state === "DRAFT") return { ok: true };
  if (current.state !== "SCHEDULED") return { ok: false, code: "state_locked" };
  if (patch.startsAtMs !== undefined && patch.startsAtMs !== current.startsAtMs) return { ok: false, code: "schedule_locked" };
  if (patch.endsAtMs !== undefined && patch.endsAtMs !== current.endsAtMs) return { ok: false, code: "schedule_locked" };
  if (patch.items !== undefined) {
    if (patch.items.length !== current.items.length) return { ok: false, code: "sku_set_locked" };
    const by = new Map(current.items.map((i) => [i.skuId, i]));
    for (const n of patch.items) {
      const o = by.get(n.skuId);
      if (o === undefined) return { ok: false, code: "sku_set_locked" };
      if (n.pricePiastres !== o.pricePiastres) return { ok: false, code: "price_locked" };
      if (n.stockCap < o.stockCap) return { ok: false, code: "stock_lowered" };
    }
  }
  return { ok: true };
}

/** The lifecycle event that is due at `nowMs` (server time), or null. Pure; the sweeper applies it. */
export function dueEvent(d: Pick<Drop, "state" | "startsAtMs" | "earlyAccessAtMs" | "endsAtMs">, nowMs: number): DropEvent | null {
  switch (d.state) {
    case "SCHEDULED":
      if (nowMs >= d.startsAtMs) return "GO_LIVE";
      if (d.earlyAccessAtMs !== null && nowMs >= d.earlyAccessAtMs) return "OPEN_EARLY_ACCESS";
      return null;
    case "EARLY_ACCESS":
      return nowMs >= d.startsAtMs ? "GO_LIVE" : null;
    case "LIVE":
      return nowMs >= d.endsAtMs ? "WINDOW_CLOSED" : null;
    default:
      return null;
  }
}

export function nextState(state: DropState, event: DropEvent): DropState {
  return dropMachine.transition(state, event);
}

export type AdmissionVerdict =
  | { readonly ok: true; readonly phase: "pre_open" | "early_access" | "live" }
  | { readonly ok: false; readonly code: "not_open" | "closed" | "sold_out" | "paused" | "plus_required" };

/**
 * Who may be in the queue right now. `SCHEDULED` drops accept joins only inside the pre-queue
 * window so the waiting room is warm at the start, but nobody is admitted before the open.
 */
export function joinVerdict(
  d: Pick<Drop, "state" | "paused" | "startsAtMs" | "earlyAccessAtMs">,
  nowMs: number,
  hasEarlyAccess: boolean,
  preQueueMs: number,
): AdmissionVerdict {
  if (d.paused) return { ok: false, code: "paused" };
  switch (d.state) {
    case "DRAFT":
    case "ARCHIVED":
      return { ok: false, code: "closed" };
    case "SOLD_OUT":
      return { ok: false, code: "sold_out" };
    case "ENDED":
      return { ok: false, code: "closed" };
    case "SCHEDULED": {
      const opens = d.earlyAccessAtMs ?? d.startsAtMs;
      if (nowMs < opens - preQueueMs) return { ok: false, code: "not_open" };
      if (d.earlyAccessAtMs !== null && nowMs < d.startsAtMs && !hasEarlyAccess) return { ok: false, code: "plus_required" };
      if (nowMs >= d.startsAtMs) return { ok: true, phase: "live" };
      return { ok: true, phase: d.earlyAccessAtMs !== null && nowMs >= d.earlyAccessAtMs ? "early_access" : "pre_open" };
    }
    case "EARLY_ACCESS":
      return hasEarlyAccess ? { ok: true, phase: "early_access" } : { ok: false, code: "plus_required" };
    case "LIVE":
      return { ok: true, phase: "live" };
  }
}

/** True when admitting tickets is allowed (not merely joining). */
export function mayAdmit(d: Pick<Drop, "state" | "paused">): boolean {
  return !d.paused && (d.state === "EARLY_ACCESS" || d.state === "LIVE");
}
