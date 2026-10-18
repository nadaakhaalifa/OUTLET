import { Module, type DynamicModule } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock as PlatformClock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { InMemoryCalendarStore, UnknownEta } from "./adapters/in-memory";
import { CalendarController } from "./adapters/calendar.controller";
import { NotificationsReminderNotifier } from "./adapters/notifier";
import { EventResolver } from "./adapters/resolvers";
import { LazyStylistPorts } from "./adapters/stylist-ports";
import * as T from "./adapters/tokens";
import { AddGapToBag } from "./application/bag";
import { ClearCalendar, CreateEvent, DeleteEvent, ListEvents, UpdateEvent } from "./application/events";
import { GenerateEventOutfits } from "./application/outfits";
import { ProcessDueReminders } from "./application/reminders";
import { DEFAULT_CALENDAR_CONFIG, type CalendarConfig, type CalendarDeps, type StylistPorts } from "./application/shared";
import type { StylistFlagPort } from "../stylist";
import type { CalendarStore, DeliveryEtaPort, ReminderNotifierPort } from "./domain/ports";

export interface CalendarModuleOptions {
  readonly config?: CalendarConfig;
  readonly store?: CalendarStore;
  /** Courier p80 per store. Default: unknown (feasibility "unknown", never "ok"). */
  readonly eta?: DeliveryEtaPort;
  /** Default: the notifications module, resolved lazily. */
  readonly notifier?: ReminderNotifierPort;
  /**
   * Default: the stylist module's own ports, resolved lazily from the same container (one catalog,
   * one bag writer, one outfit store, one fair-use counter). Tests pass fakes here.
   */
  readonly stylist?: StylistPorts;
  /** Calendar kill switches. Default: the stylist module's flag port (fail closed when absent). */
  readonly flags?: StylistFlagPort;
}

/**
 * Outfit calendar (spec P3-02). Persistence is the only port this module owns outright: everything
 * else is the stylist's and the notifications module's, reached through their public surfaces.
 */
@Module({})
export class OutfitCalendarModule {
  static forRoot(config: AppConfig, o: CalendarModuleOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    const store = o.store ?? new InMemoryCalendarStore();
    const eta = o.eta ?? new UnknownEta();
    const cfg = o.config ?? DEFAULT_CALENDAR_CONFIG;

    const RUNTIME = Symbol("outfitCalendar.Runtime");
    const runtime = (ref: ModuleRef, clock: PlatformClock, ids: IdGenerator) => {
      const stylist = o.stylist ?? new LazyStylistPorts(ref);
      const d: CalendarDeps = {
        store,
        stylist,
        flags: o.flags ?? { isEnabled: (key: string) => stylist.flags.isEnabled(key) },
        eta,
        notifier: o.notifier ?? NotificationsReminderNotifier.lazy(ref),
        clock,
        ids,
        cfg,
      };
      return {
        create: new CreateEvent(d),
        update: new UpdateEvent(d),
        remove: new DeleteEvent(d),
        clear: new ClearCalendar(d),
        list: new ListEvents(d),
        generate: new GenerateEventOutfits(d),
        addGap: new AddGapToBag(d),
        reminders: new ProcessDueReminders(d),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({
      provide: token,
      inject: [RUNTIME],
      useFactory: (r: Runtime) => pick(r),
    });

    return {
      module: OutfitCalendarModule,
      controllers: [CalendarController],
      providers: [
        { provide: T.CALENDAR_STORE, useValue: store },
        { provide: T.CALENDAR_ETA, useValue: eta },
        { provide: T.CALENDAR_EVENT_RESOLVER, useValue: new EventResolver(store) },
        {
          provide: RUNTIME,
          inject: [ModuleRef, CLOCK, ID_GENERATOR],
          useFactory: (ref: ModuleRef, c: PlatformClock, ids: IdGenerator) => runtime(ref, c, ids),
        },
        from(T.CREATE_CALENDAR_EVENT, (r) => r.create),
        from(T.UPDATE_CALENDAR_EVENT, (r) => r.update),
        from(T.DELETE_CALENDAR_EVENT, (r) => r.remove),
        from(T.CLEAR_CALENDAR, (r) => r.clear),
        from(T.LIST_CALENDAR_EVENTS, (r) => r.list),
        from(T.GENERATE_EVENT_OUTFITS, (r) => r.generate),
        from(T.ADD_GAP_TO_BAG, (r) => r.addGap),
        from(T.PROCESS_CALENDAR_REMINDERS, (r) => r.reminders),
      ],
    };
  }
}

