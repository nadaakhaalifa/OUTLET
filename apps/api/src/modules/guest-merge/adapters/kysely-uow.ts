import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { KyselyCartRepository, type CartDb } from "../../cart";
import { KyselyWishlistRepository, type WishlistDb } from "../../wishlists";
import { MergeConflictError, type GuestMergedEvent, type GuestMergeUnitOfWork, type MergeTx } from "../domain/ports";

/** Advisory-lock namespace (first int4 key) for guest merges; keeps hashtext(user_id) from colliding with other modules. */
const GUEST_MERGE_LOCK_NS = 5501;

export type GuestMergeDb = Kysely<Record<string, never>>;

/** Postgres unique_violation: a concurrent writer inserted the same wishlist item or list first. */
const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

/**
 * ONE Postgres transaction for the whole merge. The cart and wishlist repositories are the production ones;
 * each opens `db.transaction().execute(...)` per call, so they are handed a view of the OUTER transaction in
 * which `transaction().execute(fn)` simply runs `fn` on it (no nested transaction, one commit, one rollback).
 * Runs under the `system` DB role like those repositories (authorization is the route policy; the user id is
 * the token subject, never a request field).
 */
export class KyselyGuestMergeUnitOfWork implements GuestMergeUnitOfWork {
  constructor(
    private readonly db: GuestMergeDb,
    private readonly ids: { uuidV7(): string } = { uuidV7: () => randomUUID() },
  ) {}

  async run<T>(userId: string, fn: (tx: MergeTx) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        await sql`select set_config('app.role', 'system', true)`.execute(trx);
        // One merge per account at a time: two first merges can no longer both create the default list of an intent.
        await sql`select pg_advisory_xact_lock(${GUEST_MERGE_LOCK_NS}, hashtext(${userId}))`.execute(trx);
        const joined = { transaction: () => ({ execute: <R>(inner: (t: typeof trx) => Promise<R>): Promise<R> => inner(trx) }) };
        const emit = async (e: GuestMergedEvent): Promise<void> => {
          const payload = JSON.stringify({
            user_id: e.userId,
            cart_id: e.cartId,
            counts: {
              added: e.counts.added,
              qty_raised: e.counts.qtyRaised,
              moved_to_saved: e.counts.movedToSaved,
              unavailable: e.counts.unavailable,
              store_suspended: e.counts.storeSuspended,
              saved_added: e.counts.savedAdded,
            },
          });
          await sql`
            insert into outbox_events (id, aggregate_type, aggregate_id, event_type, ordering_key, payload)
            values (${this.ids.uuidV7()}::uuid, 'cart', ${e.cartId}::uuid, ${e.type}, ${`cart:${e.cartId}`}, ${payload}::jsonb)`.execute(trx);
        };
        return fn({
          cart: new KyselyCartRepository(joined as unknown as CartDb),
          wishlists: new KyselyWishlistRepository(joined as unknown as WishlistDb, this.ids),
          emit,
        });
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new MergeConflictError();
      throw e;
    }
  }
}
