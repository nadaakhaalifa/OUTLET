import type { ShopperFactsEraser, ShopperPseudonymDeriver } from "../domain/erasure-ports";

/** Facts live 25 months (VR-DASH-04); every rotation epoch (UTC year) that overlaps that window can hold a key. */
export const FACTS_RETENTION_MONTHS = 25;
const BATCH = 5_000;
const MAX_BATCHES = 10_000;

/** UTC years whose pseudonyms may still sit in facts at `nowMs`. */
export function liveEpochs(nowMs: number): readonly number[] {
  const now = new Date(nowMs);
  const earliest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - FACTS_RETENTION_MONTHS, now.getUTCDate()));
  const out: number[] = [];
  for (let y = earliest.getUTCFullYear(); y <= now.getUTCFullYear(); y += 1) out.push(y);
  return out;
}

export interface ForgetShopperResult {
  readonly keys: number;
  readonly rowsNulled: number;
}

/**
 * `forgetShopper(userKey)`: NULLs `shopper_key` for HMAC(user) under every live pseudonym key and epoch. NULL, not a
 * fresh random key: a new key would still let a seller-side count link the erased person's events to each other.
 * Runs BEFORE the user row is erased (the privacy erasure flow treats a failure as a retryable step) and is
 * idempotent: a second run finds nothing to change. Rollups hold no shopper key and are untouched.
 */
export class ForgetShopper {
  constructor(
    private readonly deriver: ShopperPseudonymDeriver,
    private readonly eraser: ShopperFactsEraser,
    private readonly clock: { nowMs(): number },
  ) {}

  async execute(userKey: string): Promise<ForgetShopperResult> {
    if (userKey.length === 0) throw new Error("forgetShopper needs a user key");
    const now = this.clock.nowMs();
    const keys = [...new Set(liveEpochs(now).flatMap((year) => this.deriver.derive(userKey, new Date(Date.UTC(year, 6, 1)))))];
    if (keys.length === 0) throw new Error("no live pseudonym key: refusing to report the shopper as forgotten");
    // Record first: an ingest racing with the update then NULLs the key itself.
    await this.eraser.recordErasedKeys(keys, now);
    let rowsNulled = 0;
    for (let i = 0; i < MAX_BATCHES; i += 1) {
      const n = await this.eraser.nullShopperKeys(keys, BATCH);
      rowsNulled += n;
      if (n < BATCH) return { keys: keys.length, rowsNulled };
    }
    throw new Error("forgetShopper did not converge; will retry");
  }
}
