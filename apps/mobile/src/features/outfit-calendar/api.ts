import { dataOf, type schemas } from "../../services/api-client";
import { piastres, type AdapterContext } from "../../services/wire";
import { aiGuard } from "../ai-failure";
import type { MissingSlot, Slot } from "../stylist/model";
import { outfitFromWire, slotOf } from "../stylist/wire-outfit";
import {
  isEventKind, isSlot,
  type AddGapResult, type CalendarEvent, type CalendarPort, type Delivery, type EventDraft, type EventKind, type GapOutfit, type GapResult, type LinkStatus, type OutfitStatus, type Season,
} from "./model";

const SEASONS: readonly Season[] = ["summer", "winter", "spring", "autumn", "all"];

function deliveryOf(d: schemas.CalendarDelivery): Delivery {
  return { status: d.status, orderByDate: d.order_by_date };
}

function eventOf(e: schemas.CalendarEvent): CalendarEvent {
  const kind: EventKind = isEventKind(e.kind) ? e.kind : "custom";
  const status: OutfitStatus = e.outfit_status;
  return {
    id: e.id,
    kind,
    localDate: e.local_date,
    localTime: e.local_time,
    note: e.note,
    modest: e.modesty === "modest",
    season: SEASONS.includes(e.season_band) ? e.season_band : "all",
    budget: e.budget_piastres === null ? null : piastres(e.budget_piastres),
    ownedSlots: e.owned_slots.filter(isSlot),
    remindersEnabled: e.reminders_enabled,
    archived: e.status === "archived",
    outfitStatus: status,
    outfits: e.outfits.map((o) => ({ outfitId: o.outfit_id, status: o.status as LinkStatus })),
    version: e.version,
  };
}

function missingOf(m: readonly schemas.CalendarMissingSlot[]): readonly MissingSlot[] {
  const out: MissingSlot[] = [];
  for (const x of m) out.push({ slot: x.slot, shortfall: x.add_piastres === null ? 0n : piastres(x.add_piastres) });
  return out;
}

function patchBody(p: Partial<EventDraft>): schemas.CalendarEventPatchRequest {
  return {
    ...(p.kind !== undefined ? { kind: p.kind } : {}),
    ...(p.localDate !== undefined ? { local_date: p.localDate } : {}),
    ...(p.localTime !== undefined && p.localTime !== null ? { local_time: p.localTime } : {}),
    ...(p.note !== undefined ? { note: p.note } : {}),
    ...(p.modest !== undefined ? { modesty: p.modest ? "modest" : "standard" } : {}),
    ...(p.season !== undefined ? { season_band: p.season } : {}),
    ...(p.budget !== undefined ? { budget_piastres: p.budget === null ? null : p.budget.toString() } : {}),
    ...(p.remindersEnabled !== undefined ? { reminders_enabled: p.remindersEnabled } : {}),
  };
}

/**
 * /v1/me/calendar/events*. Writes carry a client-generated idempotency key (UUIDv7). The note is the only free
 * text and the API never sends it to an LLM. The device-calendar import (`source: "device"`) is not offered
 * (it needs a native calendar module).
 */
export class ApiCalendarPort implements CalendarPort {
  constructor(private readonly ctx: AdapterContext) {}

  list(includeArchived: boolean): Promise<readonly CalendarEvent[]> {
    return aiGuard(async () => {
      const out: CalendarEvent[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 5; page += 1) {
        const r = dataOf(await this.ctx.client.listMyCalendarEvents({ query: { include_archived: includeArchived ? "true" : "false", limit: 50, ...(cursor !== undefined ? { cursor } : {}) } }));
        out.push(...r.items.map(eventOf));
        if (r.next_cursor === null) break;
        cursor = r.next_cursor;
      }
      return out;
    });
  }

  create(d: EventDraft): Promise<CalendarEvent> {
    return aiGuard(async () => {
      const body: schemas.CalendarEventCreateRequest = {
        source: "manual",
        kind: d.kind,
        local_date: d.localDate,
        ...(d.localTime !== null ? { local_time: d.localTime } : {}),
        ...(d.note !== null ? { note: d.note } : {}),
        modesty: d.modest ? "modest" : "standard",
        season_band: d.season,
        ...(d.budget !== null ? { budget_piastres: d.budget.toString() } : {}),
        reminders_enabled: d.remindersEnabled,
      };
      return eventOf(dataOf(await this.ctx.client.createMyCalendarEvent({ body })));
    });
  }

  update(id: string, patch: Partial<EventDraft>): Promise<CalendarEvent> {
    return aiGuard(async () => eventOf(dataOf(await this.ctx.client.updateMyCalendarEvent({ path: { eventId: id }, body: patchBody(patch) }))));
  }

  remove(id: string): Promise<void> {
    return aiGuard(async () => {
      dataOf(await this.ctx.client.deleteMyCalendarEvent({ path: { eventId: id } }));
    });
  }

  clear(): Promise<void> {
    return aiGuard(async () => {
      dataOf(await this.ctx.client.clearMyCalendar());
    });
  }

  generate(eventId: string, useRemainingBudget: boolean): Promise<GapResult> {
    return aiGuard(async () => {
      const r = dataOf(await this.ctx.client.generateCalendarEventOutfits({ path: { eventId }, body: { use_remaining_budget: useRemainingBudget } }));
      const outfits: GapOutfit[] = r.outfits.map((o) => ({
        outfit: outfitFromWire({ id: o.outfit_id, items: o.items, per_store: o.per_store, missing: o.missing.map((m) => ({ slot: m.slot, add_piastres: m.add_piastres })) }),
        complete: o.complete,
        total: piastres(o.total_piastres),
        ownedSlots: o.owned_slots.map((s) => slotOf(s)).filter((s): s is Slot => s !== null),
        missing: missingOf(o.missing),
        delivery: deliveryOf(o.delivery),
      }));
      return { outfits, ownedOnly: r.owned_only, shortfall: missingOf(r.shortfall), source: r.source === "ml" && r.fallback_reason === "none" ? "ai" : "rules", remainingToday: r.quota.remaining_today };
    });
  }

  addGap(eventId: string, outfitId: string): Promise<AddGapResult> {
    return aiGuard(async () => {
      const r = dataOf(await this.ctx.client.addCalendarGapToBag({ path: { eventId }, body: { outfit_id: outfitId } }));
      return { added: r.added, alreadyAdded: r.already_added, unavailable: r.unavailable.length, priceChanges: r.price_changes.length, delivery: r.delivery === undefined ? null : deliveryOf(r.delivery) };
    });
  }
}
