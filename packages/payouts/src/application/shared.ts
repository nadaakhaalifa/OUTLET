import { withDbContext } from "@outlet/db";
import type { Queryable, RoleSqlClient } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import type { Currency } from "@outlet/money";

export type FinanceJob = "finance.payouts" | "finance.reconcile";

export interface FinanceDeps {
  readonly client: RoleSqlClient<"outlet_worker">;
  readonly currency: Currency;
  readonly now: () => Date;
}

const outbox = new OutboxWriter(pgTransactionalWriter);

export const inJob = <T>(deps: FinanceDeps, marketId: string, job: FinanceJob, fn: (tx: Queryable) => Promise<T>): Promise<T> =>
  withDbContext(deps.client, { kind: "worker", marketId, job }, fn);

export const emit = (tx: Queryable, marketId: string, now: Date, type: string, aggregateType: string, aggregateId: string, payload: Record<string, string | number | boolean | null>): Promise<unknown> =>
  outbox.append(tx, { id: uuidv7(), type, aggregateType, aggregateId, marketId, occurredAt: now.toISOString(), payload });

export const toDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));
