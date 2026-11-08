import type { Queryable } from "@outlet/db";
import { MoneyDto } from "../domain/dto.js";
import type { Env } from "./env.js";

export const emit = async (
  env: Env,
  tx: Queryable,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, string | number | boolean | null | readonly unknown[]>,
  visibility: "internal" | "public" = "internal",
): Promise<void> => {
  await env.outbox.append(tx, { id: env.newId(), type, aggregateType, aggregateId, marketId: env.marketId, occurredAt: env.now().toISOString(), visibility, payload: payload });
};

export interface PriceChange {
  readonly skuId: string;
  readonly productId: string;
  readonly storeId: string;
  readonly oldPriceMinor: bigint | null;
  readonly newPriceMinor: bigint;
  readonly currency: string;
  readonly source: "seller" | "import";
}

/** Price Watch input: every price write emits one price.changed in the same transaction (amounts as decimal strings, never floats). */
export const emitPriceChanged = async (env: Env, tx: Queryable, c: PriceChange): Promise<void> => {
  MoneyDto.parse({ amount_minor: c.newPriceMinor.toString(), currency: c.currency });
  await emit(env, tx, "price.changed", "sku", c.skuId, {
    sku_id: c.skuId,
    product_id: c.productId,
    store_id: c.storeId,
    old_price_minor: c.oldPriceMinor === null ? null : c.oldPriceMinor.toString(),
    new_price_minor: c.newPriceMinor.toString(),
    currency: c.currency,
    source: c.source,
    changed_at: env.now().toISOString(),
  });
};
