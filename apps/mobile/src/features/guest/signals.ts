/**
 * "Is this phone signed out?" for public surfaces (ADR-0055), and the device-only signals adapters re-rank with.
 * Adapters see these through `AdapterContext`; screens use `useGuestMode`. Reading the device store never touches the network.
 */
import type { AdapterContext, GuestSignals } from "../../services/wire";
import type { GuestStorePort } from "./port";

export async function isGuestSession(tokens: { load(): Promise<unknown | null> }): Promise<boolean> {
  return (await tokens.load()) === null;
}

/** Snapshot of the device-only affinity counters and recently viewed (newest first). */
export async function readGuestSignals(store: GuestStorePort): Promise<GuestSignals> {
  await store.hydrate();
  const s = store.getState();
  return { stores: s.affinity.stores, categories: s.affinity.categories, viewed: s.viewed.map((v) => v.productId), historyPaused: s.settings.historyPaused };
}

/** Adds the device store's signals to an adapter context (the only way adapters see them). */
export function withGuestStore(ctx: AdapterContext, store: GuestStorePort): AdapterContext {
  return { ...ctx, guestSignals: () => readGuestSignals(store) };
}
