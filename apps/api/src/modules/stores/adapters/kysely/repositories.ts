import { sql, type Selectable, type Transaction } from "kysely";
import type { KycState } from "@outlet/domain";
import type { KyselyTransactionRunner } from "../../../../platform/db";
import type { FavoriteRow } from "../../domain/favorites";
import type { FavoriteRepository, StoreActivityFeed, StoreRepository } from "../../domain/ports";
import type { LegalIdentity, Store, StoreStats } from "../../domain/store";
import type { StoresDb, StoresTable, StoreDirectoryStatsTable, StoreLegalIdentityPublicTable } from "./schema";
import type { SessionProvider } from "./session";

type Trx = Transaction<StoresDb>;
type Runner = KyselyTransactionRunner<StoresDb>;

const EMPTY_STATS: StoreStats = {
  maxVerifiedDiscountPct: null,
  ratingAvg: null,
  ratingCount: 0,
  liveDrop: false,
  trendingScore: 0,
  lastDropAtMs: null,
  p80DeliveryHours: null,
};

function toStore(
  s: Selectable<StoresTable>,
  st: Selectable<StoreDirectoryStatsTable> | undefined,
  lg: Selectable<StoreLegalIdentityPublicTable> | undefined,
): Store {
  const stats: StoreStats =
    st === undefined
      ? EMPTY_STATS
      : {
          maxVerifiedDiscountPct: st.max_verified_discount_pct,
          ratingAvg: st.rating_avg === null ? null : Number(st.rating_avg),
          ratingCount: st.rating_count,
          liveDrop: st.live_drop,
          trendingScore: st.trending_score,
          lastDropAtMs: st.last_drop_at === null ? null : st.last_drop_at.getTime(),
          p80DeliveryHours: st.p80_delivery_hours,
        };
  const legalIdentity: LegalIdentity | null =
    lg === undefined
      ? null
      : {
          legalNameAr: lg.legal_name_ar,
          legalNameEn: lg.legal_name_en,
          commercialRegisterNo: lg.commercial_register_no,
          taxCardNo: lg.tax_card_no,
          governorate: lg.governorate,
        };
  return {
    id: s.id,
    sellerId: s.seller_id,
    kind: s.kind,
    slug: s.slug,
    nameAr: s.name_ar,
    nameEn: s.name_en,
    descriptionAr: s.description_ar,
    descriptionEn: s.description_en,
    status: s.status,
    sellerKycState: s.seller_kyc_state as KycState,
    healthScore: s.health_score,
    verifiedBadge: s.verified_badge,
    logoUrl: s.logo_url,
    coverUrl: s.cover_url,
    freeDeliveryThresholdAmount: BigInt(s.free_delivery_threshold_amount),
    stats,
    legalIdentity,
  };
}

/**
 * Postgres StoreRepository. Reads run under the injected identity, so a customer session sees only
 * shopper-visible stores and a seller session adds its own tenant (policy stores_select). Writes need
 * ops/system (stores_insert) or a staff member of the store; the platform-column guard trigger rejects
 * seller-role changes to lifecycle columns.
 */
export class KyselyStoreRepository implements StoreRepository {
  constructor(
    private readonly runner: Runner,
    private readonly session: SessionProvider,
  ) {}

  private run<T>(process: string, fn: (trx: Trx) => Promise<T>): Promise<T> {
    return this.runner.run({ session: this.session(), process, profile: "default" }, (tx) => fn(tx.db));
  }

  private async hydrate(trx: Trx, rows: readonly Selectable<StoresTable>[]): Promise<Store[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [stats, legal] = await Promise.all([
      trx.selectFrom("store_directory_stats").selectAll().where("store_id", "in", ids).execute(),
      trx.selectFrom("store_legal_identity_public").selectAll().where("store_id", "in", ids).execute(),
    ]);
    const sm = new Map(stats.map((s) => [s.store_id, s]));
    const lm = new Map(legal.map((l) => [l.store_id, l]));
    return rows.map((r) => toStore(r, sm.get(r.id), lm.get(r.id)));
  }

  all(): Promise<readonly Store[]> {
    return this.run("stores.all", async (trx) => this.hydrate(trx, await trx.selectFrom("stores").selectAll().orderBy("created_at").orderBy("id").execute()));
  }

  findById(id: string): Promise<Store | null> {
    return this.run("stores.read", async (trx) => {
      const r = await trx.selectFrom("stores").selectAll().where("id", "=", id).executeTakeFirst();
      return r === undefined ? null : ((await this.hydrate(trx, [r]))[0] ?? null);
    });
  }

  bySeller(sellerId: string): Promise<readonly Store[]> {
    return this.run("stores.by_seller", async (trx) =>
      this.hydrate(trx, await trx.selectFrom("stores").selectAll().where("seller_id", "=", sellerId).orderBy("created_at").orderBy("id").execute()),
    );
  }

  async save(store: Store): Promise<void> {
    await this.run("stores.save", async (trx) => {
      const values = {
        seller_id: store.sellerId,
        kind: store.kind,
        slug: store.slug,
        name_ar: store.nameAr,
        name_en: store.nameEn,
        description_ar: store.descriptionAr,
        description_en: store.descriptionEn,
        status: store.status,
        seller_kyc_state: store.sellerKycState,
        health_score: store.healthScore,
        verified_badge: store.verifiedBadge,
        logo_url: store.logoUrl,
        cover_url: store.coverUrl,
        free_delivery_threshold_amount: store.freeDeliveryThresholdAmount.toString(),
      };
      const existing = await trx.selectFrom("stores").selectAll().where("id", "=", store.id).forUpdate().executeTakeFirst();
      let prior: Store | null = null;
      if (existing === undefined) {
        await trx.insertInto("stores").values({ id: store.id, ...values }).execute();
        await trx.insertInto("store_directory_stats").values({ store_id: store.id }).execute();
      } else {
        prior = (await this.hydrate(trx, [existing]))[0] ?? null;
        const done = await trx.updateTable("stores").set(values).where("id", "=", store.id).returning("id").executeTakeFirst();
        if (done === undefined) throw new Error("store update was not permitted");
      }
      // Stats and legal identity are platform-written (ops/system by policy): untouched values are not
      // rewritten, so a seller editing presentation fields never trips those policies.
      const st = store.stats;
      if (prior === null || JSON.stringify(prior.stats) !== JSON.stringify(st)) {
        await trx
          .updateTable("store_directory_stats")
          .set({
            max_verified_discount_pct: st.maxVerifiedDiscountPct,
            rating_avg: st.ratingAvg === null ? null : st.ratingAvg.toFixed(2),
            rating_count: st.ratingCount,
            live_drop: st.liveDrop,
            trending_score: st.trendingScore,
            last_drop_at: st.lastDropAtMs === null ? null : new Date(st.lastDropAtMs).toISOString(),
            p80_delivery_hours: st.p80DeliveryHours,
          })
          .where("store_id", "=", store.id)
          .execute();
      }
      const lg = store.legalIdentity;
      if (lg === null && prior !== null && prior.legalIdentity !== null) {
        await trx.deleteFrom("store_legal_identity_public").where("store_id", "=", store.id).execute();
      }
      if (lg !== null && (prior === null || JSON.stringify(prior.legalIdentity) !== JSON.stringify(lg))) {
        const row = {
          legal_name_ar: lg.legalNameAr,
          legal_name_en: lg.legalNameEn,
          commercial_register_no: lg.commercialRegisterNo,
          tax_card_no: lg.taxCardNo,
          governorate: lg.governorate,
        };
        const had = prior?.legalIdentity !== null && prior !== null;
        if (had) await trx.updateTable("store_legal_identity_public").set(row).where("store_id", "=", store.id).execute();
        else await trx.insertInto("store_legal_identity_public").values({ store_id: store.id, ...row }).execute();
      }
    });
  }
}

/** Favourites are class A (user-owned): the session must carry the user id or be `system`. */
export class KyselyFavoriteRepository implements FavoriteRepository {
  constructor(
    private readonly runner: Runner,
    private readonly session: SessionProvider,
  ) {}

  async list(userId: string): Promise<readonly FavoriteRow[]> {
    return this.runner.run({ session: this.session(), process: "stores.favorites_list", profile: "read" }, async (tx) => {
      const rows = await tx.db
        .selectFrom("user_favorite_stores")
        .select(["store_id", "position", "last_seen_at"])
        .where("user_id", "=", userId)
        .orderBy("position")
        .execute();
      return rows.map((r) => ({ storeId: r.store_id, position: r.position, lastSeenAtMs: r.last_seen_at.getTime() }));
    });
  }

  async replace(userId: string, rows: readonly FavoriteRow[]): Promise<void> {
    await this.runner.run({ session: this.session(), process: "stores.favorites_replace", profile: "default" }, async (tx) => {
      // (user_id, position) is DEFERRABLE INITIALLY DEFERRED, so delete + insert is safe in one transaction.
      await tx.db.deleteFrom("user_favorite_stores").where("user_id", "=", userId).execute();
      if (rows.length === 0) return;
      await tx.db
        .insertInto("user_favorite_stores")
        .values(
          rows.map((r) => ({
            user_id: userId,
            store_id: r.storeId,
            position: r.position,
            last_seen_at: new Date(r.lastSeenAtMs).toISOString(),
          })),
        )
        .execute();
    });
  }

  /**
   * Counts only (never who), through the SECURITY DEFINER aggregate store_follower_counts() so no
   * role elevation is needed and the caller keeps its own identity.
   */
  async followerCounts(): Promise<ReadonlyMap<string, number>> {
    return this.runner.run({ session: this.session(), process: "stores.follower_counts", profile: "read" }, async (tx) => {
      const res = await sql<{ store_id: string; followers: string }>`select store_id, followers from store_follower_counts()`.execute(tx.db);
      return new Map(res.rows.map((r) => [r.store_id, Number(r.followers)]));
    });
  }
}

/** Reads and (for the catalog consumer) appends the append-only activity feed. */
export class KyselyStoreActivityFeed implements StoreActivityFeed {
  constructor(
    private readonly runner: Runner,
    private readonly session: SessionProvider,
  ) {}

  async occurredAtMsByStore(storeIds: readonly string[]): Promise<ReadonlyMap<string, readonly number[]>> {
    const out = new Map<string, number[]>(storeIds.map((id) => [id, []]));
    if (storeIds.length === 0) return out;
    return this.runner.run({ session: this.session(), process: "stores.activity_read", profile: "read" }, async (tx) => {
      const rows = await tx.db
        .selectFrom("store_activity_events")
        .select(["store_id", "occurred_at"])
        .where("store_id", "in", [...storeIds])
        .orderBy("occurred_at")
        .execute();
      for (const r of rows) out.get(r.store_id)?.push(r.occurred_at.getTime());
      return out;
    });
  }

  /** Consumer side (ops/system only by policy). */
  async record(storeId: string, kind: "product_published" | "drop_scheduled", occurredAtMs: number): Promise<void> {
    await this.runner.run({ session: this.session(), process: "stores.activity_record", profile: "default" }, async (tx) => {
      await tx.db
        .insertInto("store_activity_events")
        .values({ store_id: storeId, kind, occurred_at: new Date(occurredAtMs).toISOString() })
        .execute();
    });
  }
}
