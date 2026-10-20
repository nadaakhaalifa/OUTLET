import { requireOptionalNativeModule } from "expo";
import { setNativeRandomSource } from "./random";

interface ExpoCryptoModule {
  getRandomValues?: (array: Uint8Array) => Uint8Array | void;
}

/**
 * Hermes has no `crypto.getRandomValues` in Expo Go and some builds. The ExpoCrypto native module (system
 * CSPRNG) is used when it is linked. Without it nothing is registered and callers fail closed.
 */
export function installNativeRandom(): void {
  const mod = requireOptionalNativeModule<ExpoCryptoModule>("ExpoCrypto");
  if (mod === null || mod === undefined || typeof mod.getRandomValues !== "function") return;
  const fill = mod.getRandomValues.bind(mod);
  setNativeRandomSource({
    getRandomValues: (array: Uint8Array) => {
      fill(array);
      return array;
    },
  });
}
