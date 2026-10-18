import type { GuestStorePort } from "./port";

/** SecureStore key of the guest size profile (P3, Keychain, never in SQLite). Owned by the size-profile work (G4). */
export const GUEST_SIZE_PROFILE_KEY = "outlet.guest.sizeprofile";

/** Under-18 block (E9) and "Clear data on this phone": empties the guest store and the guest size profile. */
export async function wipeGuestData(store: Pick<GuestStorePort, "clearAll">, secure: { remove(key: string): Promise<void> }): Promise<void> {
  await store.clearAll();
  await secure.remove(GUEST_SIZE_PROFILE_KEY);
}

/** Sign-out (F6): forget a pending merge key so the next account never reuses it. Call from Me / sign-out (G3). */
export function onSignedOut(store: Pick<GuestStorePort, "setMergePending">): void {
  store.setMergePending(null);
}
