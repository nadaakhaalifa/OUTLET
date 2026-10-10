import { z } from "zod";
import { MAX_RESERVATION_LINES, MAX_UNITS_PER_SKU, PAYMENT_METHODS, STOCK_REASONS } from "../domain/core";

const Uuid = z.uuid();

export const ReserveStockInput = z
  .object({
    orderGroupId: Uuid,
    userId: Uuid,
    paymentMethod: z.enum(PAYMENT_METHODS),
    lines: z
      .array(z.object({ skuId: Uuid, qty: z.number().int().min(1).max(MAX_UNITS_PER_SKU) }).strict())
      .min(1)
      .max(MAX_RESERVATION_LINES),
  })
  .strict();
export type ReserveStockInput = z.infer<typeof ReserveStockInput>;

export const OrderGroupInput = z.object({ orderGroupId: Uuid }).strict();

export const SyncStockInput = z
  .object({
    skuId: Uuid,
    /** Store ids the caller holds a brand grant for. The SKU must belong to one of them. */
    actorStoreIds: z.array(Uuid).min(1),
    actorId: z.string().min(1).max(100),
    actorType: z.enum(["seller", "channel", "system"]),
    mode: z.enum(["set", "adjust"]),
    quantity: z.number().int().min(-10_000_000).max(10_000_000),
    reason: z.enum(STOCK_REASONS),
    idempotencyKey: z.string().min(1).max(200),
    expectedVersion: z.number().int().min(0).optional(),
    sourceVersion: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((v) => v.mode === "adjust" ? v.quantity !== 0 : v.quantity >= 0, {
    message: "set needs quantity >= 0; adjust needs a non-zero delta",
    path: ["quantity"],
  });
export type SyncStockInput = z.infer<typeof SyncStockInput>;

export const TransferPoolInput = z
  .object({
    skuId: Uuid,
    toPool: z.enum(["FAWRY", "STANDARD"]),
    qty: z.number().int().min(1).max(1_000_000),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export type TransferPoolInput = z.infer<typeof TransferPoolInput>;
