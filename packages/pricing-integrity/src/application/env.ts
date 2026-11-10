import type { Queryable, SqlClient } from "@outlet/db";
import type { KillSwitchName } from "@outlet/flags";
import { uuidv7 } from "@outlet/ids";
import { computeWindow, WINDOW_MS } from "../domain/window.js";
import type { PriceEventInput, PriceWindow } from "../domain/window.js";

/** The money-class (fail closed) switch registered in @outlet/flags KILL_SWITCHES. */
export const PRICE_WATCH_KILL_SWITCH = "pricing.price_watch.enabled" as const satisfies KillSwitchName;

/**
 * Port over FlagService.isKilled(PRICE_WATCH_KILL_SWITCH, { marketId }). True = killed. A throwing port is treated as killed:
 * with no readable flag state every shopper surface shows the plain price (fail closed).
 */
export interface PriceWatchKillSwitch {
  isKilled(): Promise<boolean>;
}

export interface PricingDeps {
  readonly client: SqlClient;
  readonly marketId: string;
  readonly killSwitch: PriceWatchKillSwitch;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

export interface Env {
  readonly client: SqlClient;
  readonly marketId: string;
  readonly killSwitch: PriceWatchKillSwitch;
  readonly now: () => Date;
  readonly newId: () => string;
}

export const makeEnv = (d: PricingDeps): Env => ({ client: d.client, marketId: d.marketId, killSwitch: d.killSwitch, now: d.now ?? (() => new Date()), newId: d.newId ?? (() => uuidv7()) });

export const isKilled = async (env: Env): Promise<boolean> => {
  try {
    return await env.killSwitch.isKilled();
  } catch {
    return true;
  }
};

interface EventRow {
  id: string;
  price_minor: string;
  valid_from: Date | string;
  valid_to: Date | string | null;
  currency: string;
}

export interface LoadedHistory {
  readonly events: readonly PriceEventInput[];
  readonly firstSeenAt: Date | undefined;
  readonly currency: string | undefined;
  readonly rows: readonly { id: string; priceMinor: bigint; validFrom: Date; validTo: Date | null }[];
}

/**
 * Events in effect at any time in the last 61 days (enough for a 30 day run plus its 30 day prior window) and the first observation.
 * The slice is exact because a price held >= 30 days ends any run (see domain/window.ts), so older rows cannot alter the reference, the 30 day low or the label (lastIncreaseAt older than the slice reads as null).
 * Rows may overlap when a late event was inserted; the effective end of a row is the next row's start.
 */
export const loadHistory = async (db: Queryable, skuId: string, marketId: string, now: Date): Promise<LoadedHistory> => {
  const since = new Date(now.getTime() - 2 * WINDOW_MS - 86_400_000);
  const r = await db.query<EventRow>(
    `SELECT id, price_minor::text AS price_minor, valid_from, valid_to, currency FROM price_events
      WHERE sku_id = $1 AND market_id = $2 AND source = 'internal' AND (valid_to IS NULL OR valid_to >= $3)
      ORDER BY valid_from ASC, id ASC`,
    [skuId, marketId, since],
  );
  const first = await db.query<{ first_seen: Date | string | null }>(
    "SELECT min(valid_from) AS first_seen FROM price_events WHERE sku_id = $1 AND market_id = $2 AND source = 'internal'",
    [skuId, marketId],
  );
  const base = r.rows.map((x) => ({ id: x.id, priceMinor: BigInt(x.price_minor), validFrom: new Date(x.valid_from) }));
  const rows = base.map((x, i) => ({ ...x, validTo: base[i + 1]?.validFrom ?? null }));
  const fs = first.rows[0]?.first_seen;
  return {
    events: rows.map((x) => ({ id: x.id, priceMinor: x.priceMinor, validFrom: x.validFrom })),
    firstSeenAt: fs === null || fs === undefined ? undefined : new Date(fs),
    currency: r.rows[r.rows.length - 1]?.currency,
    rows,
  };
};

export const windowFor = (h: LoadedHistory, now: Date): PriceWindow => computeWindow(h.events, now, h.firstSeenAt === undefined ? {} : { firstSeenAt: h.firstSeenAt });
