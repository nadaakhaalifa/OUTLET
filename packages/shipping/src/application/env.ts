import type { RoleSqlClient } from "@outlet/db";

export interface ShippingDeps {
  /** Connection as outlet_app (ADR-0011). Every call binds its own context. */
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly now?: () => Date;
  /** Reads kill switch `shipping.international.enabled`. Default: disabled (fail closed). */
  readonly isInternationalEnabled?: () => Promise<boolean>;
}
export interface Env {
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly now: () => Date;
  readonly isInternationalEnabled: () => Promise<boolean>;
}
export const makeEnv = (d: ShippingDeps): Env => ({
  client: d.client,
  marketId: d.marketId,
  now: d.now ?? (() => new Date()),
  isInternationalEnabled: d.isInternationalEnabled ?? (() => Promise.resolve(false)),
});
export const INTERNATIONAL_KILL_SWITCH = "shipping.international.enabled";
