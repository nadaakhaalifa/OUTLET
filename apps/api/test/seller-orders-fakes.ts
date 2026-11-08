import { randomUUID } from "node:crypto";
import type { SqlClient } from "@outlet/db";
import type { BuyerDelivery, BuyerDeliveryPort } from "../src/modules/seller-orders/index.js";
import type { Seed } from "./harness.js";

/** Test-only delivery source: an order gets the default delivery unless a test sets (or clears) one. */
export class InMemoryBuyerDelivery implements BuyerDeliveryPort {
  readonly byOrder = new Map<string, BuyerDelivery | null>();
  readonly default: BuyerDelivery = {
    recipientName: "منى أحمد",
    phone: "+201012345678",
    address: { governorateCode: "CAI", cityCode: "NASR", street: "شارع مصطفى النحاس", building: "12", floor: "3", apartment: "7", landmark: "أمام الصيدلية", pin: { lat: 30.05, lng: 31.33 } },
    accessUntil: null,
  };
  forSellerOrder(i: { storeId: string; sellerOrderId: string }): Promise<BuyerDelivery | null> {
    return Promise.resolve(this.byOrder.has(i.sellerOrderId) ? (this.byOrder.get(i.sellerOrderId) ?? null) : this.default);
  }
}

export interface SeededOrder { readonly id: string; readonly groupId: string; readonly userId: string }

/** One order group with a single seller order and line for `storeId`, inserted directly (RLS-bypassing test client). */
export const seedSellerOrder = async (
  raw: SqlClient, seed: Seed, o: { storeId: string; status?: string; paymentMethod?: string; createdAt?: string; totalMinor?: number },
): Promise<SeededOrder> => {
  const userId = randomUUID(), sessionId = randomUUID(), groupId = randomUUID(), id = randomUUID();
  const status = o.status ?? "PAID";
  const method = o.paymentMethod ?? "card";
  const total = o.totalMinor ?? 129_900;
  const at = o.createdAt ?? new Date().toISOString();
  await raw.query("INSERT INTO users (id, market_id, created_at, updated_at) VALUES ($1,'EG',$2,$2)", [userId, at]);
  await raw.query(
    `INSERT INTO checkout_sessions (id, user_id, market_id, currency, quote, quote_hash, payment_method, price_lock_expires_at, status)
     VALUES ($1,$2,'EG','EGP','{}'::jsonb, decode(repeat('ab', 32), 'hex'), $3, $4, 'completed')`,
    [sessionId, userId, method, at],
  );
  await raw.query(
    `INSERT INTO order_groups (id, user_id, market_id, currency, status, funds_flow, checkout_session_id, idempotency_key, payment_method, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor, placed_at, created_at)
     VALUES ($1,$2,'EG','EGP',$3,'collect_payout',$4,$5,$6,$7,0,0,0,$7,$8,$8)`,
    [groupId, userId, method === "cod" ? "CONFIRMED_COD" : "PAID", sessionId, randomUUID(), method, total, at],
  );
  await raw.query(
    `INSERT INTO seller_orders (id, order_group_id, store_id, user_id, market_id, currency, status, funds_flow, items_subtotal_minor, shipping_minor, shipping_vat_minor, vat_minor, total_minor,
        commission_bp_snapshot, commission_minor, commission_vat_minor, seller_net_minor, accept_by, created_at)
     VALUES ($1,$2,$3,$4,'EG','EGP',$5,'collect_payout',$6,0,0,0,$6,1400,0,0,$6,$7,$8)`,
    [id, groupId, o.storeId, userId, status, total, new Date(Date.parse(at) + 24 * 3600_000).toISOString(), at],
  );
  await raw.query(
    `INSERT INTO order_lines (id, seller_order_id, order_group_id, store_id, user_id, market_id, sku_id, product_id, title_ar_snapshot, condition_grade_snapshot, qty, unit_price_minor, currency, tax_category, vat_rate_bp, vat_minor, claim_type_snapshot)
     VALUES ($1,$2,$3,$4,$5,'EG',$6,$7,'فستان صيفي','new_with_imperfections',1,$8,'EGP','standard',1400,0,'plain')`,
    [randomUUID(), id, groupId, o.storeId, userId, seed.skuA, seed.productA, total],
  );
  return { id, groupId, userId };
};
