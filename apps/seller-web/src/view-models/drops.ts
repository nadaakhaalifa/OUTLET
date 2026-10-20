import type { DropInput } from "../api/client";
import type { DropType, SellerDrop } from "../api/schemas-phase2";
import type { Locale, MessageKey } from "../i18n";
import { cairoLocalToIso } from "../lib/cairo-time";
import { formatDateTime, formatInt, formatMoney } from "../lib/format";
import { parseEgpToMinor } from "../lib/money-input";
import type { DraftResult } from "./ads";

export const DROP_TYPES: readonly DropType[] = ["public", "members_only", "flash_hour", "mystery_box", "price_ladder", "last_chance"];

const STATES = ["DRAFT", "SCHEDULED", "EARLY_ACCESS", "LIVE", "SOLD_OUT", "ENDED", "ARCHIVED"] as const;
export type DropState = (typeof STATES)[number];
export const normaliseState = (s: string): DropState | null => {
  const u = s.toUpperCase();
  return (STATES as readonly string[]).includes(u) ? (u as DropState) : null;
};

export interface Editability {
  /** Schedule, title, price, limits: only while DRAFT. */
  readonly full: boolean;
  /** After SCHEDULED the only allowed edit is raising a stock cap (master prompt section 16). */
  readonly stockIncreaseOnly: boolean;
  readonly canSchedule: boolean;
}

export function editability(state: string): Editability {
  const s = normaliseState(state);
  if (s === "DRAFT") return { full: true, stockIncreaseOnly: false, canSchedule: true };
  if (s === "SCHEDULED" || s === "EARLY_ACCESS" || s === "LIVE") return { full: false, stockIncreaseOnly: true, canSchedule: false };
  return { full: false, stockIncreaseOnly: false, canSchedule: false };
}

export type StockEditError = "decrease" | "price_changed" | "sku_changed" | "locked";

/** Compares current items with proposed ones. After SCHEDULED a stock cap may only go up and prices never change. */
export function checkStockEdit(
  state: string,
  prev: readonly { sku_id: string; stock_cap: number; price: bigint }[],
  next: readonly { sku_id: string; stock_cap: number; price: bigint }[],
): readonly StockEditError[] {
  const e = editability(state);
  if (e.full) return [];
  if (!e.stockIncreaseOnly) return ["locked"];
  const errors = new Set<StockEditError>();
  if (next.length !== prev.length) errors.add("sku_changed");
  for (const n of next) {
    const p = prev.find((x) => x.sku_id === n.sku_id);
    if (p === undefined) errors.add("sku_changed");
    else {
      if (n.stock_cap < p.stock_cap) errors.add("decrease");
      if (n.price !== p.price) errors.add("price_changed");
    }
  }
  return [...errors];
}

export interface DropRowVM {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly typeKey: MessageKey;
  readonly stateRaw: string;
  readonly stateKey: MessageKey;
  readonly paused: boolean;
  readonly startsAt: string;
  readonly startsAtIso: string;
  readonly earlyAccessAt: string | null;
  readonly endsAt: string;
  readonly limits: string;
  readonly items: readonly { readonly sku: string; readonly stock: string; readonly stockCap: number; readonly price: string; readonly priceMinor: string }[];
  readonly mystery: string | null;
  readonly canSchedule: boolean;
  readonly canRaiseStock: boolean;
  readonly soldOutWaitlist: boolean;
  /** Server clock per row (the response carries `server_time`); used for the starts-in countdown. */
  readonly serverTimeMs: number;
}

export function dropRows(items: readonly SellerDrop[], locale: Locale): readonly DropRowVM[] {
  return items.map((d) => {
    const st = normaliseState(d.state);
    const ed = editability(d.state);
    return {
      id: d.id,
      version: d.version,
      title: d.title,
      typeKey: `drops.type.${d.type}` as MessageKey,
      stateRaw: d.state,
      stateKey: st === null ? "drops.state.unknown" : (`drops.state.${st}` as MessageKey),
      paused: d.paused,
      startsAt: formatDateTime(d.starts_at, locale),
      startsAtIso: d.starts_at,
      earlyAccessAt: d.early_access_at === null ? null : formatDateTime(d.early_access_at, locale),
      endsAt: formatDateTime(d.ends_at, locale),
      limits: `${formatInt(d.limits.per_user, locale)} / ${formatInt(d.limits.per_device, locale)}`,
      items: d.items.map((i) => ({
        sku: i.sku_id, stock: formatInt(i.stock_cap, locale), stockCap: i.stock_cap, price: formatMoney(i.price, locale), priceMinor: i.price.toString(),
      })),
      mystery: d.mystery === null ? null : `${formatMoney(d.mystery.min_value, locale)} - ${formatMoney(d.mystery.max_value, locale)}`,
      canSchedule: ed.canSchedule,
      canRaiseStock: ed.stockIncreaseOnly,
      soldOutWaitlist: st === "SOLD_OUT",
      serverTimeMs: Date.parse(d.server_time),
    };
  });
}

export interface DropDraft {
  readonly type: string;
  readonly title: string;
  readonly startsAtLocal: string;
  readonly earlyAccessLocal: string;
  readonly endsAtLocal: string;
  readonly skuId: string;
  readonly stockCap: string;
  readonly price: string;
  readonly perUser: string;
  readonly perDevice: string;
  readonly ladderAtLocal: string;
  readonly ladderPrice: string;
  readonly mysteryMin: string;
  readonly mysteryMax: string;
  readonly mysteryGuaranteed: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const int = (s: string): number | null => (/^\d{1,6}$/.test(s.trim()) ? Number(s.trim()) : null);

export function validateDrop(d: DropDraft): DraftResult<DropInput> {
  const errors: MessageKey[] = [];
  const type = DROP_TYPES.find((x) => x === d.type);
  if (type === undefined) errors.push("drops.err.type");
  const title = d.title.trim();
  if (title.length < 2 || title.length > 120) errors.push("drops.err.title");
  const start = cairoLocalToIso(d.startsAtLocal);
  const end = cairoLocalToIso(d.endsAtLocal);
  if (start === null) errors.push("drops.err.start");
  if (end === null) errors.push("drops.err.end");
  if (start !== null && end !== null && Date.parse(end) <= Date.parse(start)) errors.push("drops.err.endBeforeStart");
  let early: string | null = null;
  if (d.earlyAccessLocal.trim() !== "") {
    early = cairoLocalToIso(d.earlyAccessLocal);
    if (early === null || (start !== null && Date.parse(early) >= Date.parse(start))) errors.push("drops.err.early");
    if (type !== undefined && type !== "members_only") errors.push("drops.err.earlyType");
  }
  if (!UUID.test(d.skuId.trim())) errors.push("drops.err.sku");
  const stock = int(d.stockCap);
  if (stock === null || stock < 1 || stock > 100000) errors.push("drops.err.stock");
  const price = parseEgpToMinor(d.price);
  if (price === null) errors.push("drops.err.price");
  const perUser = int(d.perUser);
  const perDevice = int(d.perDevice);
  if (perUser === null || perUser < 1 || perUser > 10 || perDevice === null || perDevice < 1 || perDevice > 10) errors.push("drops.err.limits");
  else if (perDevice < perUser) errors.push("drops.err.deviceBelowUser");

  let ladder: { at: string; price: string }[] | undefined;
  if (type === "price_ladder") {
    const at = cairoLocalToIso(d.ladderAtLocal);
    const lp = parseEgpToMinor(d.ladderPrice);
    if (at === null || lp === null || (start !== null && Date.parse(at) <= Date.parse(start)) || (end !== null && Date.parse(at) >= Date.parse(end))) errors.push("drops.err.ladder");
    else if (price !== null && BigInt(lp) >= BigInt(price)) errors.push("drops.err.ladderNotLower");
    else ladder = [{ at, price: lp }];
  }
  let mystery: { min_value: string; max_value: string; guaranteed_min: string } | undefined;
  if (type === "mystery_box") {
    const lo = parseEgpToMinor(d.mysteryMin);
    const hi = parseEgpToMinor(d.mysteryMax);
    const g = parseEgpToMinor(d.mysteryGuaranteed);
    if (lo === null || hi === null || g === null || BigInt(lo) > BigInt(hi) || BigInt(g) < BigInt(lo) || BigInt(g) > BigInt(hi)) errors.push("drops.err.mystery");
    else mystery = { min_value: lo, max_value: hi, guaranteed_min: g };
  }
  if (errors.length > 0 || type === undefined || start === null || end === null || stock === null || price === null || perUser === null || perDevice === null) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      type, title, starts_at: start, early_access_at: early, ends_at: end,
      items: [{ sku_id: d.skuId.trim(), stock_cap: stock, price }],
      limits: { per_user: perUser, per_device: perDevice },
      ...(ladder === undefined ? {} : { ladder }),
      ...(mystery === undefined ? {} : { mystery }),
    },
  };
}
