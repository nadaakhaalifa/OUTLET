import { withDbContext } from "@outlet/db";
import { uuidv7 } from "@outlet/ids";
import { OutboxWriter, pgTransactionalWriter } from "@outlet/outbox";
import { z } from "zod";
import { addressSchema } from "../domain/address.js";
import { ShippingError } from "../domain/errors.js";
import type { CourierPort, LabelStorePort, ShipmentLabelPort } from "../domain/ports.js";
import { makeEnv } from "./env.js";
import type { Env, ShippingDeps } from "./env.js";

export const shipmentInput = z.object({
  storeId: z.uuid(),
  userId: z.uuid(),
  sellerOrderIds: z.array(z.uuid()).min(1).max(20),
  direction: z.enum(["outbound", "return"]).default("outbound"),
  courier: z.string().min(1).max(40),
  serviceLevel: z.string().min(1).max(40),
  parcels: z.array(z.object({ weightG: z.number().int().positive(), dimsMm: z.object({ lengthMm: z.number().int().positive(), widthMm: z.number().int().positive(), heightMm: z.number().int().positive() }).optional() })).min(1).max(10),
  destination: addressSchema,
  codMinor: z.bigint().nonnegative().default(0n),
});
export type ShipmentInput = z.input<typeof shipmentInput>;

export interface ShipmentView { readonly id: string; readonly awb: string; readonly status: string; readonly labelObjectKey: string; readonly replayed: boolean }

export interface ShipmentDeps extends ShippingDeps {
  readonly courier: CourierPort;
  readonly labels: ShipmentLabelPort;
  readonly labelStore: LabelStorePort;
  readonly outbox?: OutboxWriter;
  readonly newId?: () => string;
}

interface Row { id: string; awb: string | null; status: string; label_object_key: string | null }

export class ShipmentService {
  private readonly env: Env;
  private readonly outbox: OutboxWriter;
  private readonly newId: () => string;
  constructor(private readonly d: ShipmentDeps) {
    this.env = makeEnv(d);
    this.outbox = d.outbox ?? new OutboxWriter(pgTransactionalWriter);
    this.newId = d.newId ?? (() => uuidv7());
  }

  /**
   * Idempotent by the seller-order set. Row first (LABEL_PENDING, own tx), then the courier call and label upload OUTSIDE any tx
   * (the courier dedups on the shipment id), then awb + label key + `shipment.created` in one tx. A failed courier call leaves
   * LABEL_PENDING; a retry re-uses the same shipment id.
   */
  async create(raw: ShipmentInput): Promise<ShipmentView> {
    const p = shipmentInput.safeParse(raw);
    if (!p.success) throw new ShippingError("INVALID_INPUT", "invalid shipment");
    const i = p.data;
    const env = this.env;
    const key = `${i.direction}:${[...i.sellerOrderIds].sort().join(",")}`;
    const ctx = { kind: "store" as const, marketId: env.marketId, storeId: i.storeId, userId: i.userId };
    const weight = i.parcels.reduce((s, x) => s + x.weightG, 0);
    const now = env.now().toISOString();
    const row = await withDbContext(env.client, ctx, async (tx) => {
      await tx.query(
        `INSERT INTO shipments (id, market_id, store_id, user_id, seller_order_ids, direction, courier, service_level, declared_weight_g, cod_amount_minor, idempotency_key, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::timestamptz,$12::timestamptz) ON CONFLICT (idempotency_key) DO NOTHING`,
        [this.newId(), env.marketId, i.storeId, i.userId, i.sellerOrderIds, i.direction, i.courier, i.serviceLevel, weight, i.codMinor.toString(), key, now],
      );
      return (await tx.query<Row>("SELECT id, awb, status, label_object_key FROM shipments WHERE idempotency_key = $1 AND store_id = $2", [key, i.storeId])).rows[0];
    });
    if (row === undefined) throw new ShippingError("not_found", "not_found");
    if (row.awb !== null && row.label_object_key !== null) return { id: row.id, awb: row.awb, status: row.status, labelObjectKey: row.label_object_key, replayed: true };
    let awb: string;
    const labelKey = `labels/${env.marketId}/${row.id}.pdf`;
    try {
      awb = (await this.d.courier.createShipment({ shipmentId: row.id, courier: i.courier, serviceLevel: i.serviceLevel, parcels: i.parcels.map((x) => ({ weightG: x.weightG, ...(x.dimsMm === undefined ? {} : { dimsMm: x.dimsMm }) })), destination: i.destination, codMinor: i.codMinor })).awb;
      const label = await this.d.labels.getLabel(awb);
      await this.d.labelStore.put(labelKey, label.bytes, label.contentType);
    } catch {
      throw new ShippingError("COURIER_UNAVAILABLE", "courier unavailable; retry creates the same shipment");
    }
    await withDbContext(env.client, ctx, async (tx) => {
      const won = await tx.query("UPDATE shipments SET awb = $2, status = 'LABEL_READY', label_object_key = $3, version = version + 1, updated_at = $4::timestamptz WHERE id = $1 AND status = 'LABEL_PENDING' RETURNING id", [row.id, awb, labelKey, now]);
      if (won.rows.length === 0) return;
      await this.outbox.append(tx, {
        id: this.newId(), type: "shipment.created", aggregateType: "shipment", aggregateId: row.id, marketId: env.marketId, occurredAt: now, visibility: "internal",
        payload: { shipment_id: row.id, seller_order_ids: i.sellerOrderIds, store_id: i.storeId, market_id: env.marketId, courier: i.courier, awb, direction: i.direction, cod_amount_minor: i.codMinor.toString() },
      });
    });
    return { id: row.id, awb, status: "LABEL_READY", labelObjectKey: labelKey, replayed: false };
  }
}
