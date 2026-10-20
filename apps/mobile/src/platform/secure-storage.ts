import { z } from "zod";

/** The only accessibility class this app uses: readable while unlocked, never migrated to another device or backup. */
export const SECURE_ACCESSIBILITY = "WHEN_UNLOCKED_THIS_DEVICE_ONLY" as const;
export type SecureAccessibility = typeof SECURE_ACCESSIBILITY;

/** Port over expo-secure-store. The expo adapter lives in expo-secure-store-backend.ts. */
export interface SecureStoreBackend {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options: { readonly accessibility: SecureAccessibility }): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export class SecureStorageError extends Error {
  readonly code: "invalid_key" | "backend_failure" | "value_too_large";
  constructor(code: SecureStorageError["code"], message: string) {
    super(message);
    this.name = "SecureStorageError";
    this.code = code;
  }
}

/** expo-secure-store keys: alphanumeric, ".", "-" and "_" only. */
const KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
/** expo-secure-store warns above ~2048 bytes on some platforms; stay under it. */
export const MAX_VALUE_BYTES = 2048;

function byteLength(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return n;
}

export class SecureStorage {
  constructor(private readonly backend: SecureStoreBackend) {}

  private checkKey(key: string): void {
    if (!KEY_PATTERN.test(key)) throw new SecureStorageError("invalid_key", "secure storage key has invalid characters");
  }

  async getString(key: string): Promise<string | null> {
    this.checkKey(key);
    try {
      return await this.backend.getItemAsync(key);
    } catch {
      throw new SecureStorageError("backend_failure", "secure storage read failed");
    }
  }

  async setString(key: string, value: string): Promise<void> {
    this.checkKey(key);
    if (byteLength(value) > MAX_VALUE_BYTES) throw new SecureStorageError("value_too_large", "value exceeds secure storage limit");
    try {
      await this.backend.setItemAsync(key, value, { accessibility: SECURE_ACCESSIBILITY });
    } catch {
      throw new SecureStorageError("backend_failure", "secure storage write failed");
    }
  }

  async remove(key: string): Promise<void> {
    this.checkKey(key);
    try {
      await this.backend.deleteItemAsync(key);
    } catch {
      throw new SecureStorageError("backend_failure", "secure storage delete failed");
    }
  }

  /** Corrupt or schema-mismatched values are deleted and reported as absent, never repaired. */
  async getJson<T>(key: string, schema: z.ZodType<T>): Promise<T | null> {
    const raw = await this.getString(key);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      await this.remove(key);
      return null;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      await this.remove(key);
      return null;
    }
    return result.data;
  }

  async setJson(key: string, value: unknown): Promise<void> {
    await this.setString(key, JSON.stringify(value));
  }
}

export const STORAGE_KEYS = {
  tokens: "outlet.auth.tokens",
  consent: "outlet.privacy.consent",
  deviceSoftBlock: "outlet.privacy.devicesoftblock",
  installId: "outlet.device.installid",
  onboardingDone: "outlet.onboarding.done",
  onboardingResume: "outlet.onboarding.resume",
  localePreference: "outlet.pref.locale",
  rolePreference: "outlet.pref.role",
  onboardingPrefs: "outlet.onboarding.prefs",
  /** First-run region and shop-for preference. Device-local only, never sent anywhere. */
  regionPreference: "outlet.pref.region",
} as const;

export const AuthTokensSchema = z
  .object({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1),
    accessExpiresAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type AuthTokens = z.infer<typeof AuthTokensSchema>;

/** Token storage. Tokens only ever live in the secure store, never in app state snapshots or logs. */
export class TokenStorage {
  constructor(private readonly storage: SecureStorage) {}
  load(): Promise<AuthTokens | null> {
    return this.storage.getJson(STORAGE_KEYS.tokens, AuthTokensSchema);
  }
  async save(tokens: AuthTokens): Promise<void> {
    await this.storage.setJson(STORAGE_KEYS.tokens, AuthTokensSchema.parse(tokens));
  }
  clear(): Promise<void> {
    return this.storage.remove(STORAGE_KEYS.tokens);
  }
}
