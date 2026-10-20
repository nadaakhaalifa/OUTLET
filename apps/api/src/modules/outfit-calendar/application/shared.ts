import type {
  BagPort,
  BudgetPort,
  CandidateSourcePort,
  EmbeddingPort,
  LivePricePort,
  PersonalizationPort,
  StylistFlagPort,
  StylistStore,
} from "../../stylist";
import { cairoParts, outfitStatus, type OutfitStatus } from "../domain/bridge";
import type { CalendarEvent, CalendarStore, Clock, DeliveryEtaPort, IdPort, OutfitLink, ReminderNotifierPort } from "../domain/ports";

/** Kill switches (packages/feature-flags registry). `true` means the capability is allowed. */
export const FLAG_GAP_FILL = "kill.calendar_gap_fill";
export const FLAG_REMINDERS = "kill.calendar_reminders";
export const FLAG_STYLIST_ML = "kill.stylist_ml";

/** The stylist module's ports and persistence, resolved from the same instances the stylist uses. */
export interface StylistPorts {
  readonly candidates: CandidateSourcePort;
  readonly embeddings: EmbeddingPort;
  readonly budget: BudgetPort;
  readonly personalization: PersonalizationPort;
  readonly live: LivePricePort;
  readonly bag: BagPort;
  readonly flags: StylistFlagPort;
  /** Outfits persisted here share the stylist's fair-use counter and add-to-bag bookkeeping. */
  readonly outfits: Pick<StylistStore, "insertOutfits" | "getOutfit" | "countSince" | "markAddedToBag" | "getStyleVector">;
}

export interface CalendarConfig {
  /** Same fair-use ceiling as the stylist (spec 11): calendar generations count against it. */
  readonly dailyGenerations: number;
  readonly mlTimeoutMs: number;
  readonly freeDeliveryThresholdPiastres: bigint;
  readonly maxReminderAttempts: number;
  readonly reminderLeaseMs: number;
}

export const DEFAULT_CALENDAR_CONFIG: CalendarConfig = {
  dailyGenerations: 30,
  mlTimeoutMs: 800,
  freeDeliveryThresholdPiastres: 200_000n,
  maxReminderAttempts: 5,
  reminderLeaseMs: 10 * 60_000,
};

export interface CalendarDeps {
  readonly store: CalendarStore;
  readonly stylist: StylistPorts;
  /** Calendar kill switches (gap fill, reminders). The stylist ML switch is read from `stylist.flags`. */
  readonly flags: StylistFlagPort;
  readonly eta: DeliveryEtaPort;
  readonly notifier: ReminderNotifierPort;
  readonly clock: Clock;
  readonly ids: IdPort;
  readonly cfg: CalendarConfig;
}

export const DAY_MS = 86_400_000;
export const startOfUtcDay = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

/** Fail closed: a flag provider error means the capability is blocked. */
export async function flagOn(flags: StylistFlagPort, key: string): Promise<boolean> {
  try {
    return await flags.isEnabled(key);
  } catch {
    return false;
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error("failed"));
      },
    );
  });
}

/** Past events read as archived even before the sweeper has flagged them. */
export const isArchived = (e: CalendarEvent, nowMs: number): boolean => e.status === "archived" || e.startsAtMs <= nowMs;

export interface EventView {
  readonly event: CalendarEvent;
  readonly archived: boolean;
  readonly outfitStatus: OutfitStatus;
  readonly links: readonly OutfitLink[];
  readonly localMinute: number;
}

export function viewOf(e: CalendarEvent, links: readonly OutfitLink[], nowMs: number): EventView {
  return {
    event: e,
    archived: isArchived(e, nowMs),
    outfitStatus: outfitStatus({ ownedSlots: e.ownedSlots, linkStatuses: links.map((l) => l.status) }),
    links,
    localMinute: cairoParts(e.startsAtMs).minuteOfDay,
  };
}

import { combineFeasibility, deliveryFeasibility, type Feasibility } from "../domain/bridge";

/**
 * Delivery feasibility of buying `storeIds` now for `event` (spec P3-02 Rules). Courier outage or no
 * data degrades to "unknown"; the result never carries a promise.
 */
export async function feasibilityFor(
  d: CalendarDeps,
  userId: string,
  event: CalendarEvent,
  storeIds: readonly string[],
): Promise<Feasibility> {
  const stores = [...new Set(storeIds)];
  if (stores.length === 0) return { status: "ok", orderByDateKey: cairoParts(event.startsAtMs).dateKey, guaranteed: false };
  let p80: ReadonlyMap<string, number | null>;
  try {
    p80 = await d.eta.p80Days(userId, stores);
  } catch {
    p80 = new Map();
  }
  const now = d.clock.nowMs();
  return combineFeasibility(
    stores.map((s) => deliveryFeasibility({ nowMs: now, startsAtMs: event.startsAtMs, p80Days: p80.get(s) ?? null })),
  );
}
