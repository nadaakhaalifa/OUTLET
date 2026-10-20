import type { KycContext, KycEvent, KycState } from "@outlet/domain";
import { nextSellerKycState, nextStoreStatus, type StoreEvent, type StoreStatus } from "../domain/store";
import type { StoreRepository } from "../domain/ports";

export class SellerStoresNotFoundError extends Error {
  constructor() {
    super("no stores for seller");
    this.name = "SellerStoresNotFoundError";
  }
}

export interface KycTransitionResult {
  readonly sellerId: string;
  readonly from: KycState;
  readonly to: KycState;
  readonly affectedStoreIds: readonly string[];
}

/**
 * Runs the shared KYC machine for a seller and caches the new state on every store of that
 * seller. Invalid transitions and failed guards throw the machine's typed errors and change nothing.
 */
export class ApplySellerKycEvent {
  constructor(private readonly stores: StoreRepository) {}

  async execute(sellerId: string, event: KycEvent, ctx: KycContext): Promise<KycTransitionResult> {
    const stores = await this.stores.bySeller(sellerId);
    const first = stores[0];
    if (first === undefined) throw new SellerStoresNotFoundError();
    const from = first.sellerKycState;
    const to = nextSellerKycState(from, event, ctx);
    for (const s of stores) await this.stores.save({ ...s, sellerKycState: to });
    return { sellerId, from, to, affectedStoreIds: stores.map((s) => s.id) };
  }
}

export interface StoreTransitionResult {
  readonly storeId: string;
  readonly from: StoreStatus;
  readonly to: StoreStatus;
}

export class ChangeStoreStatus {
  constructor(private readonly stores: StoreRepository) {}

  async execute(storeId: string, event: StoreEvent): Promise<StoreTransitionResult | null> {
    const store = await this.stores.findById(storeId);
    if (store === null) return null;
    const to = nextStoreStatus(store, event);
    await this.stores.save({ ...store, status: to });
    return { storeId, from: store.status, to };
  }
}
