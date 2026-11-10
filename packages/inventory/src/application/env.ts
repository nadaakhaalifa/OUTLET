import type { RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { DEFAULT_POOL_CAP } from "../domain/pool.js";
import { noopSoldOutFlags } from "./ports.js";
import type { SoldOutFlagPort } from "./ports.js";

export interface InventoryDeps {
  /** Connection as outlet_app (ADR-0011); every call binds its own context. For the reserve path use the dedicated checkout.reserve pool. */
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly outbox?: OutboxWriter;
  readonly now?: () => Date;
  readonly newId?: () => string;
  readonly soldOut?: SoldOutFlagPort;
  /** Pool cap per SKU and location (ADR-0005: 1000). */
  readonly poolCap?: number;
}

export interface Env {
  readonly client: RoleSqlClient<"outlet_app">;
  readonly marketId: string;
  readonly outbox: OutboxWriter;
  readonly now: () => Date;
  readonly newId: () => string;
  readonly soldOut: SoldOutFlagPort;
  readonly poolCap: number;
}

export const makeEnv = (d: InventoryDeps): Env => ({
  client: d.client,
  marketId: d.marketId,
  outbox: d.outbox ?? new OutboxWriter(pgTransactionalWriter),
  now: d.now ?? (() => new Date()),
  newId: d.newId ?? (() => uuidv7()),
  soldOut: d.soldOut ?? noopSoldOutFlags,
  poolCap: d.poolCap ?? DEFAULT_POOL_CAP,
});
