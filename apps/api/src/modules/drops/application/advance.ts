import { dueEvent, dropMachine, nextState } from "../domain/bridge";
import type { DropOutboxEvent } from "../domain/ports";
import { lifecycleEvents } from "./drops";
import { withState, type DropDeps } from "./shared";

export interface AdvanceReport {
  readonly advanced: readonly { readonly dropId: string; readonly to: string }[];
  readonly releasedReservations: number;
}

/**
 * Lifecycle sweeper (server time only): SCHEDULED -> EARLY_ACCESS -> LIVE -> ENDED and expired
 * reservation release. Idempotent: a conflict (another worker moved it) is skipped, and a
 * repeated tick finds nothing due.
 */
export class AdvanceDrops {
  constructor(private readonly d: DropDeps) {}

  async run(): Promise<AdvanceReport> {
    const { store, clock, inventory, flags } = this.d;
    const now = clock.nowMs();
    const advanced: { dropId: string; to: string }[] = [];
    for (const drop of await store.active()) {
      let cur = drop;
      // A drop may owe several steps after downtime (SCHEDULED -> LIVE -> ENDED).
      for (let guard = 0; guard < 4; guard++) {
        const ev = dueEvent(cur, now);
        if (ev === null || !dropMachine.can(cur.state, ev)) break;
        const to = nextState(cur.state, ev);
        const next = withState(cur, to, now);
        const events: DropOutboxEvent[] = [...lifecycleEvents(next, to)];
        if (to === "ENDED") events.push({ type: "drop.ended", dropId: cur.id, storeId: cur.storeId, reason: "window" });
        const r = await store.save(next, cur.version, events);
        if (r !== "ok") break;
        advanced.push({ dropId: cur.id, to });
        cur = { ...next, version: cur.version + 1 };
        if (to === "ENDED") await inventory.closeDrop(cur.id);
      }
    }
    const released = await inventory.sweepExpired(now);
    for (const id of released) await store.releasePurchase(id, now);
    if (released.length > 0) {
      for (const drop of await store.active()) await flags.clear(drop.id);
    }
    return { advanced, releasedReservations: released.length };
  }
}
