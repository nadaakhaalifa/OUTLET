import type { Kysely, Transaction } from "kysely";
import type { Clock, IdGenerator } from "../ports";
import { createOutboxRecord, type NewOutboxEvent, type OutboxRecord, type RlsSession, type UnitOfWork } from "./deps";
import type { KyselyOutboxStore } from "./outbox-store";
import type { PlatformTables } from "./schema";
import { applySession, resolveTxOptions, type TxOptions } from "./session";

/**
 * Handle passed to a use case running inside a unit of work.
 *   db         typed handle for the module's own tables (RLS applies)
 *   platformDb the same transaction typed as PlatformTables (outbox/inbox adapters use it)
 *   emit       validates and appends an outbox event IN THIS TRANSACTION
 */
export interface DbTx<DB extends PlatformTables = PlatformTables> {
  readonly db: Transaction<DB>;
  readonly platformDb: Transaction<PlatformTables>;
  readonly session: RlsSession;
  readonly process: string;
  emit(event: NewOutboxEvent): Promise<OutboxRecord>;
}

export interface TransactionRunnerDeps<DB extends PlatformTables> {
  readonly db: Kysely<DB>;
  readonly outbox: KyselyOutboxStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Role to SET LOCAL ROLE to. Default `app_user`. `null` keeps the connection role (tests only). */
  readonly applicationRole?: string | null;
}

/**
 * Runs a use case in ONE database transaction:
 *   BEGIN; SET LOCAL ROLE app_user; set_config(app.*, application_name,
 *   statement_timeout); fn(tx) [domain writes + tx.emit(...)]; COMMIT.
 * An exception anywhere rolls back state AND outbox rows together.
 *
 * Not re-entrant: do not call `run` from inside `fn` (on PGlite it deadlocks,
 * on Postgres it would open a second, independent transaction). Compose use
 * cases by passing `tx` down.
 */
export class KyselyTransactionRunner<DB extends PlatformTables = PlatformTables> {
  public constructor(private readonly deps: TransactionRunnerDeps<DB>) {}

  public async run<T>(options: TxOptions, fn: (tx: DbTx<DB>) => Promise<T>): Promise<T> {
    const resolved = resolveTxOptions(options); // validates BEFORE a transaction is opened
    const { db, outbox, clock, ids } = this.deps;
    const role = this.deps.applicationRole === undefined ? "app_user" : this.deps.applicationRole;
    return db.transaction().execute(async (trx) => {
      await applySession(trx, resolved, role);
      // Same object, narrower table map: the platform adapters only touch PlatformTables.
      const platformDb = trx as unknown as Transaction<PlatformTables>;
      const tx: DbTx<DB> = {
        db: trx,
        platformDb,
        session: resolved.session,
        process: resolved.process,
        emit: async (event) => {
          const record = createOutboxRecord(event, { id: ids.uuidV7(), now: new Date(clock.nowMs()) });
          await outbox.append({ platformDb }, record);
          return record;
        },
      };
      return fn(tx);
    });
  }

  /** Adapts to the `UnitOfWork<Tx>` port of @outlet/outbox (InboxConsumer etc.) with fixed options. */
  public unitOfWork(options: TxOptions): UnitOfWork<DbTx<DB>> {
    return { run: (fn) => this.run(options, fn) };
  }
}
