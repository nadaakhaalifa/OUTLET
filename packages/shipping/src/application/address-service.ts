import { withDbContext } from "@outlet/db";
import type { Queryable } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { z } from "zod";
import { addressSchema } from "../domain/address.js";
import type { StructuredAddress } from "../domain/address.js";
import { ShippingError } from "../domain/errors.js";
import type { PiiCipher } from "../domain/ports.js";
import { AddressValidator } from "./address-validator.js";
import { makeEnv } from "./env.js";
import type { Env, ShippingDeps } from "./env.js";

export const addressInput = z.object({
  label: z.string().trim().min(1).max(40).optional(),
  recipientName: z.string().trim().min(1).max(120),
  phone: z.string().trim().regex(/^\+?[0-9]{8,15}$/),
  address: addressSchema,
  isDefault: z.boolean().optional(),
});
export type AddressInput = z.infer<typeof addressInput>;

export interface AddressView {
  readonly id: string;
  readonly label: string | null;
  readonly recipientName: string;
  readonly phone: string;
  readonly address: StructuredAddress;
  readonly codEligible: boolean;
  readonly isDefault: boolean;
}
export interface SnapshotView { readonly recipientName: string; readonly phoneMasked: string; readonly address: StructuredAddress; readonly accessUntil: Date | null }

/** AAD = column + row id (C6): a ciphertext copied to another row fails to decrypt. */
const AAD = {
  name: (id: string) => `addresses.recipient_name_ct:${id}`, phone: (id: string) => `addresses.phone_ct:${id}`,
  addr: (id: string) => `addresses.address_ct:${id}`, pin: (id: string) => `addresses.pin_ct:${id}`,
} as const;
export const SNAPSHOT_AAD = {
  name: (id: string) => `delivery_snapshots.recipient_name_ct:${id}`, phone: (id: string) => `delivery_snapshots.phone_ct:${id}`,
  masked: (id: string) => `delivery_snapshots.phone_masked_ct:${id}`, addr: (id: string) => `delivery_snapshots.address_ct:${id}`, pin: (id: string) => `delivery_snapshots.pin_ct:${id}`,
} as const;
/** Seller access: 60 days from checkout, shortened to 30 days after DELIVERED / RTO / CANCELLED / RETURNED_TO_SELLER (B1). */
const SNAPSHOT_ACCESS_DAYS = 30;
const SELLER_ACCESS_INITIAL_DAYS = 60;
const DAY_MS = 86_400_000;

/** +20*******123: last three digits only. */
export const maskPhone = (p: string): string => `${p.startsWith("+") ? p.slice(0, 3) : ""}${"*".repeat(Math.max(p.length - 3 - (p.startsWith("+") ? 3 : 0), 0))}${p.slice(-3)}`;

/** C7: serialises default-address handling per user (the partial unique index would otherwise turn a race into a 500). */
export const DEFAULT_LOCK_SQL = "SELECT pg_advisory_xact_lock(hashtext($1))";

interface Row {
  id: string; label: string | null; recipient_name_ct: Uint8Array; phone_ct: Uint8Array; address_ct: Uint8Array; cod_eligible: boolean; is_default: boolean;
}
const COLS = "id, label, recipient_name_ct, phone_ct, address_ct, cod_eligible, is_default";

export class AddressService {
  private readonly env: Env;
  private readonly validator: AddressValidator;
  constructor(deps: ShippingDeps, private readonly cipher: PiiCipher) {
    this.env = makeEnv(deps);
    this.validator = new AddressValidator(deps);
  }

  private user<T>(userId: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return withDbContext(this.env.client, { kind: "user", marketId: this.env.marketId, userId }, fn);
  }

  private async view(r: Row): Promise<AddressView> {
    const doc = addressSchema.parse(JSON.parse(await this.cipher.decrypt(r.address_ct, AAD.addr(r.id))));
    return { id: r.id, label: r.label, recipientName: await this.cipher.decrypt(r.recipient_name_ct, AAD.name(r.id)), phone: await this.cipher.decrypt(r.phone_ct, AAD.phone(r.id)), address: doc, codEligible: r.cod_eligible, isDefault: r.is_default };
  }

  private parse(raw: unknown): AddressInput {
    const p = addressInput.safeParse(raw);
    if (!p.success) throw new ShippingError("INVALID_ADDRESS", "address is incomplete or malformed");
    return p.data;
  }

  private async cols(userId: string, i: AddressInput, id: string) {
    const r = await this.validator.validate(userId, i.address);
    const ids = [...r.areaIds];
    const district = i.address.districtCode === undefined ? null : (ids.shift() ?? null);
    const city = i.address.cityCode === undefined ? null : (ids.shift() ?? null);
    return {
      governorate: r.governorateAreaId, city, district, cod: r.codEligible,
      name: await this.cipher.encrypt(i.recipientName, AAD.name(id)), phone: await this.cipher.encrypt(i.phone, AAD.phone(id)), addr: await this.cipher.encrypt(JSON.stringify(i.address), AAD.addr(id)),
      pin: i.address.pin === undefined ? null : await this.cipher.encrypt(JSON.stringify(i.address.pin), AAD.pin(id)),
    };
  }

  async create(userId: string, raw: unknown): Promise<AddressView> {
    const i = this.parse(raw);
    const id = uuidv7();
    const c = await this.cols(userId, i, id);
    const now = this.env.now().toISOString();
    return this.user(userId, async (tx) => {
      await tx.query(DEFAULT_LOCK_SQL, [userId]);
      const has = (await tx.query("SELECT 1 FROM addresses WHERE user_id = $1 AND deleted_at IS NULL LIMIT 1", [userId])).rows.length > 0;
      const def = i.isDefault === true || !has;
      if (def) await tx.query("UPDATE addresses SET is_default = false, updated_at = $2::timestamptz WHERE user_id = $1 AND is_default", [userId, now]);
      const r = await tx.query<Row>(
        `INSERT INTO addresses (id, user_id, market_id, label, governorate_area_id, city_area_id, district_area_id, recipient_name_ct, phone_ct, address_ct, pin_ct, cod_eligible, is_default, validated_at, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$14::timestamptz,$14::timestamptz) RETURNING ${COLS}`,
        [id, userId, this.env.marketId, i.label ?? null, c.governorate, c.city, c.district, c.name, c.phone, c.addr, c.pin, c.cod, def, now],
      );
      const row = r.rows[0];
      if (row === undefined) throw new ShippingError("not_found", "not_found");
      return this.view(row);
    });
  }

  async list(userId: string): Promise<AddressView[]> {
    const rows = await this.user(userId, async (tx) => (await tx.query<Row>(`SELECT ${COLS} FROM addresses WHERE user_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at, id`, [userId])).rows);
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(userId: string, id: string): Promise<AddressView> {
    const r = await this.user(userId, async (tx) => (await tx.query<Row>(`SELECT ${COLS} FROM addresses WHERE id = $1 AND deleted_at IS NULL`, [id])).rows[0]);
    if (r === undefined) throw new ShippingError("not_found", "not_found");
    return this.view(r);
  }

  async update(userId: string, id: string, raw: unknown): Promise<AddressView> {
    const i = this.parse(raw);
    const c = await this.cols(userId, i, id);
    const now = this.env.now().toISOString();
    const r = await this.user(userId, async (tx) => {
      await tx.query(DEFAULT_LOCK_SQL, [userId]);
      if (i.isDefault === true) await tx.query("UPDATE addresses SET is_default = false, updated_at = $2::timestamptz WHERE user_id = $1 AND is_default AND id <> $3", [userId, now, id]);
      return (
        await tx.query<Row>(
          `UPDATE addresses SET label = $2, governorate_area_id = $3, city_area_id = $4, district_area_id = $5, recipient_name_ct = $6, phone_ct = $7, address_ct = $8, pin_ct = $9,
                  cod_eligible = $10, is_default = COALESCE($11, is_default), validated_at = $12::timestamptz, updated_at = $12::timestamptz
            WHERE id = $1 AND deleted_at IS NULL RETURNING ${COLS}`,
          [id, i.label ?? null, c.governorate, c.city, c.district, c.name, c.phone, c.addr, c.pin, c.cod, i.isDefault ?? null, now],
        )
      ).rows[0];
    });
    if (r === undefined) throw new ShippingError("not_found", "not_found");
    return this.view(r);
  }

  async remove(userId: string, id: string): Promise<void> {
    const n = await this.user(userId, async (tx) =>
      (await tx.query("UPDATE addresses SET deleted_at = $2::timestamptz, is_default = false, updated_at = $2::timestamptz WHERE id = $1 AND deleted_at IS NULL RETURNING id", [id, this.env.now().toISOString()])).rows.length,
    );
    if (n === 0) throw new ShippingError("not_found", "not_found");
  }

  /** COD needs a landmark and a map pin (master prompt 20.7). */
  async codEligible(userId: string, id: string): Promise<boolean> {
    return (await this.get(userId, id)).codEligible;
  }

  /**
   * Freezes recipient name, the REAL phone, a masked phone and the address for one seller order (called at checkout place, in its own
   * user-context transaction). Idempotent on the seller order. The real phone (phone_ct) is column-granted to outlet_worker only and is
   * decrypted solely for the courier call; sellers read phone_masked_ct. Seller access starts at created_at + 60 days and is shortened to
   * 30 days after a terminal shipment event (tracking job).
   */
  async snapshotForOrder(userId: string, sellerOrderId: string, addressId: string): Promise<void> {
    const a = await this.get(userId, addressId);
    const parts = [a.address.governorateCode, a.address.cityCode, a.address.districtCode].filter((c): c is string => c !== undefined);
    const nowDate = this.env.now();
    const now = nowDate.toISOString();
    const until = new Date(nowDate.getTime() + SELLER_ACCESS_INITIAL_DAYS * DAY_MS).toISOString();
    const [name, phone, masked, addr] = [
      await this.cipher.encrypt(a.recipientName, SNAPSHOT_AAD.name(sellerOrderId)), await this.cipher.encrypt(a.phone, SNAPSHOT_AAD.phone(sellerOrderId)),
      await this.cipher.encrypt(maskPhone(a.phone), SNAPSHOT_AAD.masked(sellerOrderId)), await this.cipher.encrypt(JSON.stringify(a.address), SNAPSHOT_AAD.addr(sellerOrderId)),
    ];
    const pin = a.address.pin === undefined ? null : await this.cipher.encrypt(JSON.stringify(a.address.pin), SNAPSHOT_AAD.pin(sellerOrderId));
    const ok = await this.user(userId, async (tx) => {
      const so = (await tx.query<{ order_group_id: string; store_id: string }>("SELECT order_group_id, store_id FROM seller_orders WHERE id = $1", [sellerOrderId])).rows[0];
      if (so === undefined) return false;
      const area = (await tx.query<{ id: string }>("SELECT id FROM geo_areas WHERE market_id = $1 AND code = $2", [this.env.marketId, parts[parts.length - 1]])).rows[0];
      if (area === undefined) return false;
      await tx.query(
        `INSERT INTO delivery_snapshots (seller_order_id, order_group_id, store_id, user_id, market_id, geo_area_id, recipient_name_ct, phone_ct, phone_masked_ct, address_ct, pin_ct, seller_access_until, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$13::timestamptz) ON CONFLICT (seller_order_id) DO NOTHING`,
        [sellerOrderId, so.order_group_id, so.store_id, userId, this.env.marketId, area.id, name, phone, masked, addr, pin, until, now],
      );
      return true;
    });
    if (!ok) throw new ShippingError("not_found", "not_found");
  }

  /** Seller read. RLS returns nothing once seller_access_until has passed or for another store's order. */
  async snapshotForSeller(storeId: string, sellerOrderId: string): Promise<SnapshotView | undefined> {
    const r = await withDbContext(this.env.client, { kind: "store", marketId: this.env.marketId, storeId }, async (tx) =>
      (await tx.query<{ recipient_name_ct: Uint8Array | null; phone_masked_ct: Uint8Array | null; address_ct: Uint8Array | null; seller_access_until: Date | string | null }>(
        "SELECT recipient_name_ct, phone_masked_ct, address_ct, seller_access_until FROM delivery_snapshots WHERE seller_order_id = $1", [sellerOrderId])).rows[0],
    );
    // A pseudonymised row has no ciphertext left: the seller sees nothing.
    if (r?.recipient_name_ct == null || r.phone_masked_ct == null || r.address_ct == null) return undefined;
    return {
      recipientName: await this.cipher.decrypt(r.recipient_name_ct, SNAPSHOT_AAD.name(sellerOrderId)), phoneMasked: await this.cipher.decrypt(r.phone_masked_ct, SNAPSHOT_AAD.masked(sellerOrderId)),
      address: addressSchema.parse(JSON.parse(await this.cipher.decrypt(r.address_ct, SNAPSHOT_AAD.addr(sellerOrderId)))), accessUntil: r.seller_access_until === null ? null : new Date(r.seller_access_until),
    };
  }
}
export { SELLER_ACCESS_INITIAL_DAYS, SNAPSHOT_ACCESS_DAYS };
