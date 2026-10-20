import type { Store } from "../domain/store";

/** What the adapters need to render a StoreSummary. */
export interface StoreView {
  readonly store: Store;
  readonly isFavorite: boolean;
  readonly followerCount: number;
}
