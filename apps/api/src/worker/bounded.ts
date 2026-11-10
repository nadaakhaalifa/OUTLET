import { brandClient } from "@outlet/db";
import type { DbRole, Queryable, RoleSqlClient } from "@outlet/db";

/**
 * Every transaction of a consumer runs with `SET LOCAL statement_timeout` = the per-handler timeout (chief review F3). A handler the runner
 * abandons after HandlerTimeout cannot keep a statement running past its budget, and its event is not claimable again before that budget
 * (OutboxDispatchRelay minRetryMs), so the abandoned work and the retry do not overlap for longer than one statement.
 */
export const boundedClient = <R extends DbRole>(client: RoleSqlClient<R>, timeoutMs: number): RoleSqlClient<R> => {
  const transaction = <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> =>
    client.transaction(async (tx) => {
      await tx.query("SELECT set_config('statement_timeout', $1, true)", [`${String(timeoutMs)}ms`]);
      return fn(tx);
    });
  return brandClient<R>({
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- matches the Queryable port signature
    query: <Row extends object>(sql: string, params?: readonly unknown[]) => transaction((tx) => tx.query<Row>(sql, params)),
    transaction,
  });
};
