import { Body, Controller, HttpCode, Inject, Param, Put, Req } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { SyncSellerStock } from "../application/sync-stock";
import { STOCK_REASONS } from "../domain/core";
import { INVENTORY_SKU_RESOLVER, INVENTORY_SYNC_STOCK } from "./tokens";

/** docs/api/openapi.yaml StockUpdate: additionalProperties false, all three required. */
const StockUpdateSchema = z
  .object({
    mode: z.enum(["set", "adjust"]),
    quantity: z.number().int().min(-10_000_000).max(10_000_000),
    reason: z.enum(STOCK_REASONS),
  })
  .strict();

const SkuIdParam = z.object({ skuId: z.uuid() }).strict();

/** `If-Match: "12"` (optional optimistic concurrency against the level's sync_version). */
function parseIfMatch(header: string | undefined): number | undefined {
  if (header === undefined) return undefined;
  const m = /^(?:W\/)?"?(0|[1-9][0-9]{0,15})"?$/.exec(header.trim());
  if (m === null || m[1] === undefined) {
    throw new ProblemError(400, "validation-failed", "Request validation failed", {
      code: "validation_failed",
      detail: "If-Match must be the stock version, for example \"12\".",
    });
  }
  return Number(m[1]);
}

@Controller("seller/skus")
export class StockController {
  constructor(@Inject(INVENTORY_SYNC_STOCK) private readonly sync: SyncSellerStock) {}

  /**
   * updateSellerSkuStock. 404 covers "no such SKU" and "SKU of another store" alike (API1), decided
   * by the policy guard through the resolver before this handler runs.
   */
  @Put(":skuId/stock")
  @HttpCode(200)
  @Authorize({
    audience: "seller_api",
    action: "update",
    resourceType: "store_inventory",
    resolver: INVENTORY_SKU_RESOLVER,
    idParam: "skuId",
  })
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async put(
    @Req() req: ApiRequest,
    @Param(new ZodPipe(SkuIdParam, "/params")) params: z.infer<typeof SkuIdParam>,
    @Body(new ZodPipe(StockUpdateSchema)) body: z.infer<typeof StockUpdateSchema>,
  ) {
    const principal = req.principal;
    if (principal === null || principal === undefined) throw Problems.unauthenticated();
    const key = headerValue(req, "idempotency-key");
    if (key === undefined) throw Problems.invalidIdempotencyKey();
    const storeIds = principal.actor.grants.flatMap((g) => (g.kind === "brand" ? [g.storeId] : []));
    if (storeIds.length === 0) throw Problems.notFound();

    const expectedVersion = parseIfMatch(headerValue(req, "if-match"));
    const result = await this.sync.execute({
      skuId: params.skuId,
      actorStoreIds: storeIds,
      actorId: principal.actor.id,
      actorType: "seller",
      mode: body.mode,
      quantity: body.quantity,
      reason: body.reason,
      idempotencyKey: key,
      ...(expectedVersion === undefined ? {} : { expectedVersion }),
    });
    switch (result.kind) {
      case "applied":
        return {
          sku_id: params.skuId,
          on_hand: result.level.onHand,
          reserved: result.level.reserved,
          available: result.level.available,
          updated_at: new Date(result.level.updatedAtMs).toISOString(),
        };
      case "not_found":
        throw Problems.notFound();
      case "version_conflict":
        throw new ProblemError(409, "stock-version-conflict", "Stock changed since you last read it", {
          code: "stock_version_conflict",
          extensions: { current_version: result.currentVersion },
        });
      case "negative":
        throw new ProblemError(422, "stock-negative", "Stock cannot go below zero", { code: "stock_negative" });
      case "stale":
        // Unreachable over HTTP (no source version is accepted); channel integrations use the use case.
        throw new ProblemError(409, "stock-stale", "A newer stock version was already applied", { code: "stock_stale" });
      case "invalid_input":
        throw Problems.validation([{ pointer: "/body/quantity", code: "invalid" }]);
    }
  }
}
