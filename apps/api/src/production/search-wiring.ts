import type { SearchModuleOverrides } from "../modules/search";
import {
  CatalogBackedProductFacts,
  CatalogIndexSource,
  OtelSearchSyncMetrics,
  PostgresFtsSearchPort,
  StoresBackedSummaries,
  type SearchDb,
} from "../modules/search";
import type { ListingSnapshotReader } from "../modules/catalog";
import { KyselyFavoriteRepository, KyselyStoreRepository } from "../modules/stores";
import type { PersistenceWiring } from "../persistence";

/**
 * Production search ports that exist over real modules. Layered on `PRODUCTION_PORTS(...).search`.
 *
 * Bound: `facts` (price, availability and price block from the catalog at call time, store cards from the stores
 * module, never from the index) and the index feeder (`indexWriter` + `sync`: catalog outbox events -> the
 * search_documents read model). NOT bound: the read `fallback` stays the Unconfigured binding from ports.ts, so
 * search keeps failing closed (503 provider_not_configured) and nothing a shopper sees depends on the index until
 * the owner flips that binding on purpose. `scope`, `directory`, `killSwitch` and `llm` are unchanged.
 */
export function composeSearchPorts(base: SearchModuleOverrides, pg: PersistenceWiring, snapshots: ListingSnapshotReader): SearchModuleOverrides {
  const stores = pg.stores.persistence;
  if (stores === undefined) throw new Error("search wiring needs the stores Postgres repositories");
  return {
    ...base,
    facts: new CatalogBackedProductFacts(
      snapshots,
      new StoresBackedSummaries(new KyselyStoreRepository(stores.runner, stores.session), new KyselyFavoriteRepository(stores.runner, stores.session)),
    ),
    indexWriter: PostgresFtsSearchPort.writer(pg.db as SearchDb),
    sync: { source: new CatalogIndexSource(snapshots), metrics: new OtelSearchSyncMetrics() },
  };
}
