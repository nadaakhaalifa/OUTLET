import { createHmac } from "node:crypto";
import type { ShopperKeyer } from "../domain/producers";

/**
 * HMAC-SHA256 pseudonymisation with one key per purpose, rotated yearly (master prompt T6). The
 * key bytes come from the secrets manager through the composition root; they never live here.
 * A key shorter than 32 bytes is refused so a placeholder cannot slip into production.
 */
export class HmacShopperKeyer implements ShopperKeyer {
  constructor(
    private readonly shopperKeyBytes: Uint8Array,
    private readonly termKeyBytes: Uint8Array,
  ) {
    if (shopperKeyBytes.length < 32 || termKeyBytes.length < 32) throw new RangeError("analytics pseudonym keys must be at least 32 bytes");
  }
  shopperKey(userId: string): string {
    return createHmac("sha256", this.shopperKeyBytes).update(`seller-analytics\0${userId}`).digest("hex");
  }
  termHash(normalisedTerm: string): string {
    return createHmac("sha256", this.termKeyBytes).update(`search-term\0${normalisedTerm}`).digest("hex");
  }
}
