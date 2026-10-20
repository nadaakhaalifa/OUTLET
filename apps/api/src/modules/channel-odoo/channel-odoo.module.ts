import { Module, type DynamicModule } from "@nestjs/common";
import type { AppConfig } from "../../config/env";
import { NoProductionAdaptersError } from "../../platform/platform.module";
import type { Clock, IdGenerator } from "../../platform/ports";
import { CLOCK, ID_GENERATOR } from "../../platform/tokens";
import { FakeOdooServer } from "./adapters/fake-odoo-server";
import {
  FakeOdooDns,
  InMemoryChannelDirectory,
  InMemoryOdooMetrics,
  InMemoryOdooStore,
  InMemorySkuResolver,
  RecordingPriceSink,
  RecordingStockSink,
  StaticOdooFlags,
  StaticSecrets,
} from "./adapters/in-memory";
import { OdooChannelController } from "./adapters/odoo.controller";
import { OdooStoreResolver } from "./adapters/resolvers";
import * as T from "./adapters/tokens";
import { ConnectOdooChannel, DisconnectOdooChannel, RunOdooPollBatch, SyncOdooChannel, TestOdooConnection, type OdooDeps } from "./application/odoo";
import { OdooTransport } from "./application/transport";
import { DomainPacer } from "./domain/egress";
import type {
  ChannelDirectoryPort,
  OdooDnsPort,
  OdooEgressPort,
  OdooFlagsPort,
  OdooMetrics,
  OdooSleeper,
  OdooStore,
  PriceSinkPort,
  SecretExistsPort,
  SellerSkuResolverPort,
  StockSinkPort,
} from "./domain/ports";

export interface ChannelOdooOptions {
  readonly store?: OdooStore;
  readonly directory?: ChannelDirectoryPort;
  readonly secrets?: SecretExistsPort;
  /** Backed by `kill.odoo_channel`. Fails closed. */
  readonly flags?: OdooFlagsPort;
  /** Egress through the allow-listed proxy; injects the secret into the body placeholders. */
  readonly egress?: OdooEgressPort;
  readonly dns?: OdooDnsPort;
  readonly skus?: SellerSkuResolverPort;
  readonly stock?: StockSinkPort;
  readonly prices?: PriceSinkPort;
  readonly metrics?: OdooMetrics;
  readonly sleeper?: OdooSleeper;
}

export class MissingOdooPortsError extends Error {
  constructor(readonly missing: readonly string[]) {
    super(`ChannelOdooModule requires real ${missing.join(", ")} outside test mode: supply them through forRoot(config, options)`);
    this.name = "MissingOdooPortsError";
  }
}

@Module({})
export class ChannelOdooModule {
  static forRoot(config: AppConfig, o: ChannelOdooOptions = {}): DynamicModule {
    const production = config.adapters !== "in-memory-dev";
    if (production && o.store === undefined) throw new NoProductionAdaptersError();
    if (production || config.env !== "test") {
      const missing: string[] = [];
      if (o.directory === undefined) missing.push("directory (channel_connections + verified targets)");
      if (o.secrets === undefined) missing.push("secrets (vault reference check)");
      if (o.flags === undefined) missing.push("flags (kill.odoo_channel)");
      if (o.egress === undefined) missing.push("egress (allow-listed proxy with secret injection)");
      if (o.dns === undefined) missing.push("dns (rebinding guard)");
      if (o.skus === undefined) missing.push("skus (seller SKU resolver)");
      if (o.stock === undefined) missing.push("stock (inventory SyncSellerStock)");
      if (o.prices === undefined) missing.push("prices (price-integrity recordPriceChange)");
      if (o.sleeper === undefined) missing.push("sleeper");
      if (missing.length > 0) throw new MissingOdooPortsError(missing);
    }
    const store = o.store ?? new InMemoryOdooStore();
    const directory = o.directory ?? new InMemoryChannelDirectory();
    const secrets = o.secrets ?? new StaticSecrets();
    // Dev boot keeps the channel OFF (kill switch semantics, fails closed) and the fakes have no network.
    const flags = o.flags ?? new StaticOdooFlags(false);
    const egress = o.egress ?? new FakeOdooServer();
    const dns = o.dns ?? new FakeOdooDns();
    const skus = o.skus ?? new InMemorySkuResolver();
    const stock = o.stock ?? new RecordingStockSink();
    const prices = o.prices ?? new RecordingPriceSink();
    const metrics = o.metrics ?? new InMemoryOdooMetrics();
    const sleeper = o.sleeper ?? { sleep: async () => undefined };
    const pacer = new DomainPacer();

    const RUNTIME = Symbol("channel-odoo.Runtime");
    const runtime = (clock: Clock, ids: IdGenerator) => {
      const transport = new OdooTransport({ egress, dns, directory, clock, sleeper, metrics, pacer });
      const d: OdooDeps = { store, directory, secrets, flags, transport, skus, stock, prices, metrics, clock, ids };
      const sync = new SyncOdooChannel(d);
      return {
        connect: new ConnectOdooChannel(d),
        disconnect: new DisconnectOdooChannel(d),
        test: new TestOdooConnection(d),
        sync,
        batch: new RunOdooPollBatch(d, sync),
      };
    };
    type Runtime = ReturnType<typeof runtime>;
    const from = (token: symbol, pick: (r: Runtime) => unknown) => ({ provide: token, inject: [RUNTIME], useFactory: (r: Runtime) => pick(r) });
    return {
      module: ChannelOdooModule,
      controllers: [OdooChannelController],
      providers: [
        { provide: T.ODOO_STORE, useValue: store },
        { provide: T.ODOO_DIRECTORY, useValue: directory },
        { provide: T.ODOO_STORE_RESOLVER, useValue: new OdooStoreResolver() },
        { provide: RUNTIME, inject: [CLOCK, ID_GENERATOR], useFactory: (c: Clock, ids: IdGenerator) => runtime(c, ids) },
        from(T.ODOO_CONNECT, (r) => r.connect),
        from(T.ODOO_DISCONNECT, (r) => r.disconnect),
        from(T.ODOO_TEST, (r) => r.test),
        from(T.ODOO_SYNC, (r) => r.sync),
        from(T.ODOO_POLL_BATCH, (r) => r.batch),
      ],
      exports: [T.ODOO_SYNC, T.ODOO_POLL_BATCH],
    };
  }
}
