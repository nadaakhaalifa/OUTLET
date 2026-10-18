/** PasskeyPort adapters. No native passkey library is installed in this build (see docs/design-system/brand-apply.md). */
import { BrandApplyError, type PasskeyPort } from "./model";

/**
 * ADAPTER STUB: the real adapter wraps a native WebAuthn module (react-native-passkey or an Expo module) once one is added.
 * Until then it reports "unsupported on this build", and the UI falls back to the authenticator-app (TOTP) path.
 */
export class UnsupportedPasskey implements PasskeyPort {
  async isSupported(): Promise<boolean> { return false; }
  async create(): Promise<never> { throw new BrandApplyError("unsupported", "passkeys are unsupported on this build"); }
}

/** In-memory fake for tests and design review (`supported` flips the UI between the passkey and TOTP paths). */
export class FakePasskey implements PasskeyPort {
  constructor(private readonly supported = true) {}
  async isSupported(): Promise<boolean> { return this.supported; }
  async create(): Promise<Readonly<Record<string, unknown>>> {
    if (!this.supported) throw new BrandApplyError("unsupported");
    return { id: "fake-credential", type: "public-key", response: {} };
  }
}
