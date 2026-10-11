import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import type { Clock, IdGenerator } from "../../platform/ports";
import { BostaStyleWebhookAdapter } from "./adapters/bosta/bosta-adapter";
import { FakeBostaCourier } from "./adapters/bosta/fake-bosta";
import { FulfillmentSellerController } from "./adapters/fulfillment.controller";
import {
  FakeSellerOrders,
  InMemoryFulfillmentMetrics,
  InMemoryFulfillmentRepository,
  ShipmentResolver,
  StaticCourierSecrets,
} from "./adapters/in-memory";
import { SellerOrderAccess } from "./adapters/seller-order-access";
import {
  AWB_WORKER,
  CREATE_SHIPMENT,
  DELIVERED_AT_READER,
  FULFILLMENT_COURIERS,
  FULFILLMENT_METRICS,
  FULFILLMENT_ORDERS,
  FULFILLMENT_REPOSITORY,
  FULFILLMENT_SECRETS,
  GET_LABEL,
  GET_SHIPMENT,
  INGEST_COURIER_WEBHOOK,
  SHIPMENT_RESOLVER,
} from "./adapters/tokens";
import { CourierWebhookController } from "./adapters/webhook.controller";
import { AwbWorker } from "./application/awb-worker";
import { CreateShipment, GetLabel, GetShipment, RepositoryDeliveredAtReader } from "./application/shipments";
import { IngestCourierWebhook } from "./application/webhooks";
import type {
  CourierBinding,
  CourierSecretsPort,
  FulfillmentMetrics,
  FulfillmentRepository,
  SellerOrderPort,
} from "./domain/ports";

export interface FulfillmentModuleOverrides {
  readonly repository?: FulfillmentRepository;
  readonly orders?: SellerOrderPort;
  /** Courier bindings by code. Production must supply real adapters; the fake is test mode only. */
  readonly couriers?: readonly CourierBinding[];
  readonly secrets?: CourierSecretsPort;
  readonly metrics?: FulfillmentMetrics;
}

/**
 * Thrown at boot when a port that moves parcels or authenticates couriers is not supplied
 * outside test mode. Dispatch must never run against a fixture courier or an empty secret list.
 */
export class MissingFulfillmentPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(
      `FulfillmentModule requires real ${missing.join(", ")} outside test mode: ` +
        "supply them through FulfillmentModule.forRoot(config, overrides)",
    );
    this.name = "MissingFulfillmentPortsError";
  }
}

@Module({})
export class FulfillmentModule {
  static forRoot(config: AppConfig, overrides: FulfillmentModuleOverrides = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && overrides.repository === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (overrides.orders === undefined) missing.push("orders (FULFILLMENT_ORDERS: seller order facts)");
      if (overrides.couriers === undefined || overrides.couriers.length === 0) {
        missing.push("couriers (FULFILLMENT_COURIERS: courier adapters)");
      }
      if (overrides.secrets === undefined) missing.push("secrets (FULFILLMENT_SECRETS: webhook secrets)");
      if (missing.length > 0) throw new MissingFulfillmentPortsError(missing);
    }
    const repo = overrides.repository ?? new InMemoryFulfillmentRepository();
    const bindings: readonly CourierBinding[] = overrides.couriers ?? [
      { port: new FakeBostaCourier(), webhook: new BostaStyleWebhookAdapter() },
    ];
    const couriers: ReadonlyMap<string, CourierBinding> = new Map(bindings.map((b) => [b.port.code, b]));
    const common = {
      inject: [
        FULFILLMENT_REPOSITORY,
        FULFILLMENT_ORDERS,
        FULFILLMENT_COURIERS,
        FULFILLMENT_SECRETS,
        FULFILLMENT_METRICS,
        CLOCK,
        ID_GENERATOR,
      ],
    };
    type Common = [
      FulfillmentRepository,
      SellerOrderPort,
      ReadonlyMap<string, CourierBinding>,
      CourierSecretsPort,
      FulfillmentMetrics,
      Clock,
      IdGenerator,
    ];
    const build = (a: Common) => {
      const [repository, orders, cs, secrets, metrics, clock, ids] = a;
      const ingest: { current: IngestCourierWebhook | null } = { current: null };
      const worker = new AwbWorker({
        repo: repository,
        orders,
        couriers: cs,
        metrics,
        clock,
        ids,
        afterAwbAssigned: async (courier, awb) => {
          await ingest.current?.rematchUnmatched(courier, awb);
        },
      });
      ingest.current = new IngestCourierWebhook({ repo: repository, couriers: cs, secrets, metrics, clock, ids });
      return { repository, worker, ingest: ingest.current, couriers: cs, clock, ids };
    };
    // One composition of the use cases per module instance; each provider picks its piece.
    const composition = { provide: Symbol("fulfillment.composition"), inject: common.inject, useFactory: (...a: Common) => build(a) };
    const piece = <T>(token: symbol, pick: (c: ReturnType<typeof build>) => T) => ({
      provide: token,
      inject: [composition.provide],
      useFactory: (c: ReturnType<typeof build>): T => pick(c),
    });
    return {
      module: FulfillmentModule,
      controllers: [FulfillmentSellerController, CourierWebhookController],
      providers: [
        { provide: FULFILLMENT_REPOSITORY, useValue: repo },
        // Test mode only (forRoot throws otherwise): an empty order fixture.
        { provide: FULFILLMENT_ORDERS, useValue: overrides.orders ?? new FakeSellerOrders() },
        { provide: FULFILLMENT_COURIERS, useValue: couriers },
        // Test mode default is an empty list: every webhook is rejected until secrets are supplied.
        { provide: FULFILLMENT_SECRETS, useValue: overrides.secrets ?? new StaticCourierSecrets() },
        { provide: FULFILLMENT_METRICS, useValue: overrides.metrics ?? new InMemoryFulfillmentMetrics() },
        composition,
        piece(AWB_WORKER, (c) => c.worker),
        piece(INGEST_COURIER_WEBHOOK, (c) => c.ingest),
        piece(CREATE_SHIPMENT, (c) => new CreateShipment({ repo: c.repository, couriers: c.couriers, clock: c.clock, ids: c.ids, worker: c.worker })),
        piece(GET_SHIPMENT, (c) => new GetShipment({ repo: c.repository })),
        piece(GET_LABEL, (c) => new GetLabel({ repo: c.repository, couriers: c.couriers })),
        piece(DELIVERED_AT_READER, (c) => new RepositoryDeliveredAtReader(c.repository)),
        { provide: SHIPMENT_RESOLVER, useValue: new ShipmentResolver(repo) },
        SellerOrderAccess,
      ],
      exports: [
        DELIVERED_AT_READER,
        FULFILLMENT_REPOSITORY,
        FULFILLMENT_METRICS,
        AWB_WORKER,
        INGEST_COURIER_WEBHOOK,
      ],
    };
  }
}
