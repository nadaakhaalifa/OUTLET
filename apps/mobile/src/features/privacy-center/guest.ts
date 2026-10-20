/** Guest privacy panel logic (spec section 8): everything here is on this phone; no server call. */
import { wipeGuestData } from "../guest/session";
import type { GuestStorePort } from "../guest/port";

export type ClearResult = "cleared" | "failed";

/** Deletes the guest store and the SecureStore size profile. Never throws: a storage failure is reported once. */
export async function clearLocalData(store: Pick<GuestStorePort, "clearAll">, secure: { remove(key: string): Promise<void> }): Promise<ClearResult> {
  try {
    await wipeGuestData(store, secure);
    return "cleared";
  } catch {
    return "failed";
  }
}
