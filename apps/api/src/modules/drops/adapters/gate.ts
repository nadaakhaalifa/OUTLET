import type { Clock, DropStore, SoldOutFlagPort } from "../domain/ports";

/** Structural twin of the waiting-room module's GateDrop (modules talk through ports, not imports). */
export interface GateDropView {
  readonly id: string;
  readonly storeId: string;
  readonly type: "public" | "members_only" | "flash_hour" | "mystery_box" | "price_ladder" | "last_chance";
  readonly state: "DRAFT" | "SCHEDULED" | "EARLY_ACCESS" | "LIVE" | "SOLD_OUT" | "ENDED" | "ARCHIVED";
  readonly paused: boolean;
  readonly startsAtMs: number;
  readonly earlyAccessAtMs: number | null;
  readonly admitPerSec: number;
  readonly soldOutHint: boolean;
}

/** Drops-side implementation of the waiting room's DropGatePort. */
export class DropGate {
  constructor(
    private readonly store: DropStore,
    private readonly flags: SoldOutFlagPort,
    private readonly clock: Clock,
    private readonly preQueueMs: number,
  ) {}

  async get(dropId: string): Promise<GateDropView | null> {
    const d = await this.store.get(dropId);
    if (d === null) return null;
    return {
      id: d.id,
      storeId: d.storeId,
      type: d.type,
      state: d.state,
      paused: d.paused,
      startsAtMs: d.startsAtMs,
      earlyAccessAtMs: d.earlyAccessAtMs,
      admitPerSec: d.admitPerSec,
      soldOutHint: await this.flags.isSoldOut(d.id),
    };
  }

  async activeDropIds(): Promise<readonly string[]> {
    const now = this.clock.nowMs();
    return (await this.store.active())
      .filter((d) => d.state !== "SCHEDULED" || now >= (d.earlyAccessAtMs ?? d.startsAtMs) - this.preQueueMs)
      .map((d) => d.id);
  }
}
