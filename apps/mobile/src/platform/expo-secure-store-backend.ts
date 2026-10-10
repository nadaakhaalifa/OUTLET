import * as SecureStore from "expo-secure-store";
import type { SecureStoreBackend } from "./secure-storage";

/** expo-secure-store adapter. Not exercised by unit tests (no native runtime here). */
export const expoSecureStoreBackend: SecureStoreBackend = {
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) =>
    SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
};
