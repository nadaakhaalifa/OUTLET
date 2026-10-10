import { Body, Controller, Get, Inject, Param, Post, Req, Res, StreamableFile } from "@nestjs/common";
import { sha256Hex } from "@outlet/idempotency";
import { UuidSchema } from "@outlet/validation";
import { z } from "zod";
import { AuthenticatedSelf, Authorize, Idempotent, RateLimit } from "../../../platform/decorators";
import { headerValue, type ApiRequest, type ApiResponse } from "../../../platform/http-types";
import { ProblemError, Problems } from "../../../platform/problem";
import { ZodPipe } from "../../../platform/zod.pipe";
import type { CreateShipment, GetLabel, GetShipment } from "../application/shipments";
import { SellerOrderAccess } from "./seller-order-access";
import { CREATE_SHIPMENT, GET_LABEL, GET_SHIPMENT, SHIPMENT_RESOLVER } from "./tokens";
import { shipmentWire } from "./wire";

/** Default parcel when the seller omits it (VERIFY with the courier contract: weight tiers). */
const DEFAULT_PARCEL = { weightG: 1000, pieces: 1 } as const;

const CreateBody = z
  .object({
    seller_order_ids: z.array(UuidSchema).length(1),
    courier: z.string().regex(/^[a-z0-9_-]{2,32}$/).optional(),
    parcel: z
      .object({
        weight_g: z.number().int().min(1).max(50_000),
        pieces: z.number().int().min(1).max(50).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ShipmentIdPipe = new ZodPipe(UuidSchema, "/params");

function actorOf(req: ApiRequest) {
  const a = req.principal?.actor;
  if (a === undefined) throw Problems.unauthenticated();
  return a;
}

function etagOf(wire: unknown): string {
  return `"${sha256Hex(JSON.stringify(wire)).slice(0, 32)}"`;
}

function matches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  return header.split(",").some((t) => {
    const v = t.trim();
    return v === "*" || v === etag || v === `W/${etag}`;
  });
}

@Controller("seller")
export class FulfillmentSellerController {
  constructor(
    @Inject(SellerOrderAccess) private readonly access: SellerOrderAccess,
    @Inject(CREATE_SHIPMENT) private readonly createShipment: CreateShipment,
    @Inject(GET_SHIPMENT) private readonly getShipment: GetShipment,
    @Inject(GET_LABEL) private readonly getLabel: GetLabel,
  ) {}

  @Post("shipments")
  @AuthenticatedSelf("seller_api")
  @Idempotent({ required: true })
  @RateLimit([{ dimension: "user", limit: 60, windowSeconds: 60 }])
  async create(
    @Req() req: ApiRequest,
    @Body(new ZodPipe(CreateBody)) body: z.output<typeof CreateBody>,
  ) {
    const sellerOrderId = body.seller_order_ids[0];
    if (sellerOrderId === undefined) throw Problems.notFound();
    const order = await this.access.authorizeDispatch(actorOf(req), sellerOrderId);
    const r = await this.createShipment.execute({
      order,
      courierCode: body.courier,
      parcel: {
        weightG: body.parcel?.weight_g ?? DEFAULT_PARCEL.weightG,
        pieces: body.parcel?.pieces ?? DEFAULT_PARCEL.pieces,
      },
    });
    switch (r.kind) {
      case "ok":
        return shipmentWire(r.view);
      case "courier_unsupported":
        throw new ProblemError(422, "courier-unsupported", "That courier is not available", { code: "courier_unsupported" });
      case "order_not_shippable":
        throw new ProblemError(422, "order-not-shippable", "The order cannot be shipped in its current state", {
          code: "order_not_shippable",
        });
      case "shipment_exists":
        throw new ProblemError(409, "shipment-exists", "This order already has a live shipment", {
          code: "shipment_exists",
        });
    }
  }

  @Get("shipments/:shipmentId")
  @Authorize({
    audience: "seller_api",
    action: "read",
    resourceType: "store_order",
    resolver: SHIPMENT_RESOLVER,
    idParam: "shipmentId",
  })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async read(
    @Param("shipmentId", ShipmentIdPipe) shipmentId: string,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    const view = await this.getShipment.execute(shipmentId);
    if (view === null) throw Problems.notFound();
    const wire = shipmentWire(view);
    const etag = etagOf(wire);
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, no-cache");
    if (matches(headerValue(req, "if-none-match"), etag)) throw new ProblemError(304, "not-modified", "Not modified");
    return wire;
  }

  @Get("shipments/:shipmentId/label")
  @Authorize({
    audience: "seller_api",
    action: "read",
    resourceType: "store_order",
    resolver: SHIPMENT_RESOLVER,
    idParam: "shipmentId",
  })
  @RateLimit([{ dimension: "user", limit: 120, windowSeconds: 60 }])
  async label(
    @Param("shipmentId", ShipmentIdPipe) shipmentId: string,
    @Res({ passthrough: true }) res: ApiResponse,
  ) {
    const r = await this.getLabel.execute(shipmentId);
    switch (r.kind) {
      case "not_found":
        throw Problems.notFound();
      case "not_ready":
        throw new ProblemError(409, "label-not-ready", "The label is not ready yet", { code: "label_not_ready" });
      case "unavailable":
        throw Problems.unavailable("courier_unavailable");
      case "ok":
        res.setHeader("Cache-Control", "private, no-store");
        return new StreamableFile(r.file.bytes, { type: r.file.contentType });
    }
  }
}
