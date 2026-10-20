import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { z } from "zod";
import { Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import { Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { ConnectOdooChannel, DisconnectOdooChannel, TestOdooConnection } from "../application/odoo";
import type { ChannelDirectoryPort, OdooConfig, OdooStore } from "../domain/ports";
import { ODOO_CONNECT, ODOO_DIRECTORY, ODOO_DISCONNECT, ODOO_STORE, ODOO_STORE_RESOLVER, ODOO_TEST } from "./tokens";

const StoreParam = z.object({ storeId: z.uuid() }).strict();
const ChannelParam = StoreParam.extend({ channelId: z.uuid() }).strict();
const ConnectBody = z
  .object({
    /** A verified crawl target of this store: the only host the channel may call. */
    target_id: z.uuid(),
    database: z.string().min(1).max(63).regex(/^[A-Za-z0-9_.-]+$/),
    /** Opaque secret-manager references (login + API key live in the vault, never here). */
    token_ref: z.string().min(8).max(256),
    kms_key_ref: z.string().min(8).max(256),
    pricelist_id: z.number().int().positive().nullable().default(null),
    stock_location_id: z.number().int().positive().nullable().default(null),
    poll_interval_seconds: z.number().int().min(300).max(86_400).default(900),
  })
  .strict();

/** The secret reference is never returned: the seller only learns that one is attached. */
const wire = (c: OdooConfig, status: string) => ({
  id: c.channelId,
  kind: "odoo" as const,
  status,
  target_id: c.targetId,
  database: c.database,
  pricelist_id: c.pricelistId,
  stock_location_id: c.stockLocationId,
  poll_interval_seconds: c.pollIntervalSeconds,
  breaker_open: c.breakerOpenedAtMs !== null,
  last_polled_at: c.lastPolledAtMs === null ? null : new Date(c.lastPolledAtMs).toISOString(),
  last_error_code: c.lastErrorCode,
  has_secret: true,
  created_at: new Date(c.createdAtMs).toISOString(),
});

const settings = (action: "read" | "update") =>
  Authorize({ audience: "seller_api", action, resourceType: "store_settings", resolver: ODOO_STORE_RESOLVER, idParam: "storeId" });

@Controller()
export class OdooChannelController {
  constructor(
    @Inject(ODOO_STORE) private readonly store: OdooStore,
    @Inject(ODOO_DIRECTORY) private readonly directory: ChannelDirectoryPort,
    @Inject(ODOO_CONNECT) private readonly connect: ConnectOdooChannel,
    @Inject(ODOO_DISCONNECT) private readonly disconnect: DisconnectOdooChannel,
    @Inject(ODOO_TEST) private readonly test: TestOdooConnection,
  ) {}

  @Post("seller/stores/:storeId/odoo-channels")
  @settings("update")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 10, windowSeconds: 3600 }])
  async create(
    @Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>,
    @Body(new ZodPipe(ConnectBody)) b: z.infer<typeof ConnectBody>,
  ) {
    const r = await this.connect.execute({
      storeId: p.storeId.toLowerCase(),
      targetId: b.target_id.toLowerCase(),
      database: b.database,
      tokenRef: b.token_ref,
      kmsKeyRef: b.kms_key_ref,
      pricelistId: b.pricelist_id,
      stockLocationId: b.stock_location_id,
      pollIntervalSeconds: b.poll_interval_seconds,
    });
    switch (r.kind) {
      case "connected":
        return wire(r.config, "active");
      case "exists":
        throw Problems.validation([{ pointer: "/", code: "already_connected" }]);
      case "invalid_ref":
        throw Problems.validation([{ pointer: "/token_ref", code: "invalid_reference" }]);
      case "secret_missing":
        throw Problems.validation([{ pointer: "/token_ref", code: "secret_not_found" }]);
      case "target_required":
        throw Problems.validation([{ pointer: "/target_id", code: "verified_target_required" }]);
      case "disabled":
        throw Problems.unavailable("channel_sync_disabled");
      case "failed":
        throw Problems.validation([{ pointer: "/token_ref", code: r.code === "auth_failed" ? "auth_failed" : "connection_failed" }]);
    }
  }

  @Get("seller/stores/:storeId/odoo-channels")
  @settings("read")
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async list(@Param(new ZodPipe(StoreParam, "/params")) p: z.infer<typeof StoreParam>) {
    const storeId = p.storeId.toLowerCase();
    const items = [];
    for (const c of await this.store.listConfigs(storeId)) {
      const ch = await this.directory.channel(c.channelId);
      items.push(wire(c, ch?.status ?? "revoked"));
    }
    return { items };
  }

  @Post("seller/stores/:storeId/odoo-channels/:channelId/test")
  @HttpCode(200)
  @settings("update")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 30, windowSeconds: 3600 }])
  async testConnection(@Param(new ZodPipe(ChannelParam, "/params")) p: z.infer<typeof ChannelParam>) {
    const r = await this.test.execute(p.storeId.toLowerCase(), p.channelId.toLowerCase());
    if (r.kind === "not_found") throw Problems.notFound();
    if (r.kind === "ok") return { result: "ok" as const, code: null };
    if (r.kind === "failed") return { result: "failed" as const, code: r.code };
    return { result: "failed" as const, code: r.kind };
  }

  @Delete("seller/stores/:storeId/odoo-channels/:channelId")
  @HttpCode(204)
  @settings("update")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 20, windowSeconds: 3600 }])
  async remove(@Param(new ZodPipe(ChannelParam, "/params")) p: z.infer<typeof ChannelParam>): Promise<void> {
    const r = await this.disconnect.execute(p.storeId.toLowerCase(), p.channelId.toLowerCase());
    if (r.kind === "not_found") throw Problems.notFound();
  }
}
