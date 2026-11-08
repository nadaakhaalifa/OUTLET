import { withDbContext } from "@outlet/db";
import { authorize } from "@outlet/policy";
import type { Principal } from "@outlet/policy";
import { z } from "zod";
import { ShippingError } from "../domain/errors.js";
import { makeEnv } from "./env.js";
import type { Env, ShippingDeps } from "./env.js";

export const settingsInput = z.object({
  freeThresholdOverrideMinor: z.bigint().nonnegative().nullable(),
  allowedCouriers: z.array(z.string().min(1).max(40)).max(20),
  handlingDays: z.number().int().min(0).max(14),
});
export type SettingsInput = z.infer<typeof settingsInput>;
export interface StoreShippingSettings extends SettingsInput { readonly storeId: string }

interface Row { store_id: string; free_threshold_override_minor: string | bigint | null; allowed_couriers: string[]; handling_days: number }

export class StoreShippingSettingsService {
  private readonly env: Env;
  constructor(deps: ShippingDeps) {
    this.env = makeEnv(deps);
  }

  private ctx(actor: Principal, storeId: string) {
    return { kind: "store" as const, marketId: this.env.marketId, storeId, ...(actor.userId === undefined ? {} : { userId: actor.userId }) };
  }

  /** Seller read. A foreign store is not found (404); RLS holds the same line below the policy check. */
  async get(actor: Principal, storeId: string): Promise<StoreShippingSettings | undefined> {
    const d = authorize(actor, "store.read", { type: "shipping_settings", storeId, marketId: this.env.marketId });
    if (d.effect === "deny") throw new ShippingError(d.reason, d.reason);
    // store.read is a PUBLIC action (storefront), so authorize() lets shoppers and anonymous callers through; these settings are seller-private.
    if (actor.kind === "anonymous" || actor.kind === "shopper") throw new ShippingError("not_found", "not_found");
    const r = (await withDbContext(this.env.client, this.ctx(actor, storeId), (tx) =>
      tx.query<Row>("SELECT store_id, free_threshold_override_minor, allowed_couriers, handling_days FROM store_shipping_settings WHERE store_id = $1", [storeId]),
    )).rows[0];
    return r === undefined
      ? undefined
      : { storeId: r.store_id, freeThresholdOverrideMinor: r.free_threshold_override_minor === null ? null : BigInt(r.free_threshold_override_minor), allowedCouriers: r.allowed_couriers, handlingDays: r.handling_days };
  }

  async put(actor: Principal, storeId: string, raw: unknown): Promise<void> {
    const d = authorize(actor, "store.write", { type: "shipping_settings", storeId, marketId: this.env.marketId });
    if (d.effect === "deny") throw new ShippingError(d.reason, d.reason);
    const parsed = settingsInput.safeParse(raw);
    if (!parsed.success) throw new ShippingError("INVALID_INPUT", "invalid shipping settings");
    const s = parsed.data;
    await withDbContext(this.env.client, this.ctx(actor, storeId), (tx) =>
      tx.query(
        `INSERT INTO store_shipping_settings (store_id, market_id, free_threshold_override_minor, allowed_couriers, handling_days, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (store_id) DO UPDATE SET free_threshold_override_minor = EXCLUDED.free_threshold_override_minor, allowed_couriers = EXCLUDED.allowed_couriers,
           handling_days = EXCLUDED.handling_days, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [storeId, this.env.marketId, s.freeThresholdOverrideMinor?.toString() ?? null, s.allowedCouriers, s.handlingDays, actor.userId ?? null, this.env.now().toISOString()],
      ).then(() =>
        // Public projection, same transaction (no personal data; shoppers see the free-delivery bar and ETA anyway).
        tx.query(
          `INSERT INTO shipping_public_store_settings (store_ref, market_id, free_threshold_override_minor, allowed_couriers, handling_days, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (store_ref) DO UPDATE SET free_threshold_override_minor = EXCLUDED.free_threshold_override_minor, allowed_couriers = EXCLUDED.allowed_couriers,
             handling_days = EXCLUDED.handling_days, updated_at = EXCLUDED.updated_at`,
          [storeId, this.env.marketId, s.freeThresholdOverrideMinor?.toString() ?? null, s.allowedCouriers, s.handlingDays, this.env.now().toISOString()],
        ),
      ),
    );
  }
}
