import { z } from "zod";
import type { ShopperKeyer } from "../domain/producers";
import { HmacShopperKeyer } from "./hmac-keyer";

/** Secret JSON: base64 32+ byte keys per version. `previous` is kept for one rotation so erasure lookups still match. */
const Version = z.object({ kid: z.string().min(1).max(64), shopperKey: z.string().min(1), termKey: z.string().min(1) });
const KeySet = z.object({ current: Version, previous: Version.optional() });

export interface PrimableShopperKeyer extends ShopperKeyer {
  prime(): Promise<void>;
}

/**
 * The ShopperKeyer port is synchronous but the secrets read is async, so the secret is read ONCE at boot
 * (`prime`, called from the module's OnModuleInit) and the derived HmacShopperKeyers are held in memory.
 * Fails closed: before a successful prime, or if the secret is missing or malformed, every call throws the
 * error built by `notConfigured` (a 503 ProviderNotConfiguredError in production). Key bytes and the raw
 * secret never reach logs or error messages.
 */
export class PrimedShopperKeyer implements PrimableShopperKeyer {
  private current: HmacShopperKeyer | null = null;
  private previous: HmacShopperKeyer | null = null;
  constructor(
    private readonly load: () => Promise<string | null>,
    private readonly notConfigured: () => Error,
  ) {}

  /** Throws the typed not-configured error (no detail) when the secret is absent, unreadable or invalid. */
  async prime(): Promise<void> {
    let raw: string | null;
    try {
      raw = await this.load();
    } catch {
      throw this.notConfigured();
    }
    if (raw === null) throw this.notConfigured();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw this.notConfigured();
    }
    const p = KeySet.safeParse(json);
    if (!p.success) throw this.notConfigured();
    try {
      const mk = (v: z.infer<typeof Version>) => new HmacShopperKeyer(new Uint8Array(Buffer.from(v.shopperKey, "base64")), new Uint8Array(Buffer.from(v.termKey, "base64")));
      const cur = mk(p.data.current);
      const prev = p.data.previous === undefined ? null : mk(p.data.previous);
      this.current = cur;
      this.previous = prev;
    } catch {
      throw this.notConfigured();
    }
  }

  get primed(): boolean {
    return this.current !== null;
  }

  private cur(): HmacShopperKeyer {
    if (this.current === null) throw this.notConfigured();
    return this.current;
  }

  shopperKey(userId: string): string {
    return this.cur().shopperKey(userId);
  }
  termHash(normalisedTerm: string): string {
    return this.cur().termHash(normalisedTerm);
  }

  /** Pseudonyms of `userId` under the current then the previous key, for `analytics_erased_keys` matching across one rotation. */
  shopperKeys(userId: string): readonly string[] {
    const c = this.cur().shopperKey(userId);
    return this.previous === null ? [c] : [c, this.previous.shopperKey(userId)];
  }
}
