import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { PriceWatchKillSwitch } from "./env.js";

export interface WatchDeps {
  readonly app: RoleSqlClient<"outlet_app">;
  readonly worker: RoleSqlClient<"outlet_worker">;
  readonly marketId: string;
  readonly killSwitch: PriceWatchKillSwitch;
  /** Crawler kill switch (A2.12): killed or unreadable means external evidence is ignored (internal history only). */
  readonly crawlerKilled?: () => Promise<boolean>;
  readonly now?: () => Date;
  readonly newId?: () => string;
}
export interface WatchEnv extends Required<Omit<WatchDeps, "crawlerKilled">> {
  readonly crawlerKilled: () => Promise<boolean>;
}
export const makeWatchEnv = (d: WatchDeps): WatchEnv => ({ ...d, crawlerKilled: d.crawlerKilled ?? (() => Promise.resolve(false)), now: d.now ?? (() => new Date()), newId: d.newId ?? (() => uuidv7()) });

/** Seller-facing work: store context on outlet_app (store isolation + market pin). */
export const asStore = <T>(env: WatchEnv, storeId: string, userId: string | undefined, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  withDbContext(env.app, userId === undefined ? { kind: "store", marketId: env.marketId, storeId } : { kind: "store", marketId: env.marketId, storeId, userId }, fn);
/** Scanner / scorer: worker job pricing.channels (named exception policies, market pinned). */
export const asWatchWorker = <T>(env: WatchEnv, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  withDbContext(env.worker, { kind: "worker", marketId: env.marketId, job: "pricing.channels" }, fn);

const writer = new OutboxWriter(pgTransactionalWriter);
export const emit = async (env: WatchEnv, tx: Queryable, type: string, aggregateType: string, aggregateId: string, payload: Record<string, string | number | boolean | null>): Promise<void> => {
  await writer.append(tx, { id: env.newId(), type, aggregateType, aggregateId, marketId: env.marketId, occurredAt: env.now().toISOString(), payload });
};

export class WatchError extends Error {
  constructor(readonly code: "not_found" | "unsafe_target" | "unverified" | "invalid" | "forbidden", message: string) {
    super(message);
  }
}
