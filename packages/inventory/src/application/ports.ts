/**
 * Redis pre-filter port (ADR-0005): a "definitely sold out" hint so hot reads can skip the database. It is WRITE-ONLY here:
 * nothing in this package ever reads it to decide stock. Set only when on_hand - committed <= 0, cleared when stock returns.
 */
export interface SoldOutFlagPort {
  set(skuId: string, locationId: string): Promise<void>;
  clear(skuId: string, locationId: string): Promise<void>;
}

export const noopSoldOutFlags: SoldOutFlagPort = { set: () => Promise.resolve(), clear: () => Promise.resolve() };
