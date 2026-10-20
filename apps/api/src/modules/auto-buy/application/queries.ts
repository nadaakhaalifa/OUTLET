import type { MandateWithLatest } from "../domain/ports";
import type { AutoBuyDeps } from "./shared";

export interface ListView {
  /** Kill switch is off: rules stay stored and armed, but nothing is evaluated. */
  readonly paused: boolean;
  /** Server clock, so clients anchor the cancel countdown to it. */
  readonly serverTimeMs: number;
  /** `kill.auto_buy.charge` is on: unattended rules can be created. */
  readonly unattendedAvailable: boolean;
  readonly items: readonly MandateWithLatest[];
}

export class ListMandates {
  constructor(private readonly d: AutoBuyDeps) {}

  async execute(userId: string, limit: number): Promise<ListView> {
    const [paused, unattendedAvailable, items] = await Promise.all([
      this.d.flags.rulesEnabled().then((on) => !on),
      this.d.flags.chargeEnabled(),
      this.d.store.listForUser(userId, Math.min(Math.max(limit, 1), 50)),
    ]);
    return { paused, serverTimeMs: this.d.clock.nowMs(), unattendedAvailable, items };
  }
}
