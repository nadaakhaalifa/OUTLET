import {
  FakeOdooDns,
  FakeOdooServer,
  InMemoryChannelDirectory,
  InMemoryOdooMetrics,
  InMemoryOdooStore,
  InMemorySkuResolver,
  ManualClock,
  RecordingPriceSink,
  RecordingStockSink,
  StaticOdooFlags,
  StaticSecrets,
  type OdooEgressPort,
} from "../index";
import { ConnectOdooChannel, DisconnectOdooChannel, RunOdooPollBatch, SyncOdooChannel, TestOdooConnection, type OdooDeps } from "../application/odoo";
import { OdooTransport } from "../application/transport";
import { DomainPacer } from "../domain/egress";
import type { OdooHttpRequest, OdooHttpResponse } from "../domain/ports";

export const STORE_A = "00000000-0000-4000-a000-000000000001";
export const STORE_B = "00000000-0000-4000-a000-000000000002";
export const TARGET_A = "00000000-0000-4000-b000-000000000001";
export const TARGET_B = "00000000-0000-4000-b000-000000000002";
export const SKU = (n: number): string => `00000000-0000-4000-c000-${String(n).padStart(12, "0")}`;
export const TOKEN_REF = "vault://odoo/store-a";
export const KMS_REF = "kms://key/store-a";
export const API_KEY = "odoo-api-key-DO-NOT-LEAK-7f3a9";
export const LOGIN = "integration@shop-a.example";
export const PUBLIC_IP = "93.184.216.34";

/** Wraps the fake server and records the clock at every call (per-domain politeness proof). */
class TimedEgress implements OdooEgressPort {
  readonly times: number[] = [];
  constructor(
    private readonly inner: FakeOdooServer,
    private readonly clock: ManualClock,
  ) {}
  async postJson(req: OdooHttpRequest): Promise<OdooHttpResponse> {
    this.times.push(this.clock.nowMs());
    return this.inner.postJson(req);
  }
}

export interface OdooHarness {
  readonly server: FakeOdooServer;
  readonly egress: TimedEgress;
  readonly store: InMemoryOdooStore;
  readonly directory: InMemoryChannelDirectory;
  readonly secrets: StaticSecrets;
  readonly flags: StaticOdooFlags;
  readonly dns: FakeOdooDns;
  readonly skus: InMemorySkuResolver;
  readonly stock: RecordingStockSink;
  readonly prices: RecordingPriceSink;
  readonly metrics: InMemoryOdooMetrics;
  readonly clock: ManualClock;
  readonly deps: OdooDeps;
  readonly connect: ConnectOdooChannel;
  readonly disconnect: DisconnectOdooChannel;
  readonly test: TestOdooConnection;
  readonly sync: SyncOdooChannel;
  readonly batch: RunOdooPollBatch;
  /** Connects store A to the fake Odoo and returns the channel id. */
  connectA(o?: { pricelistId?: number | null; stockLocationId?: number | null; pollIntervalSeconds?: number }): Promise<string>;
}

export function createOdooHarness(): OdooHarness {
  const clock = new ManualClock();
  const server = new FakeOdooServer();
  server.account = { login: LOGIN, apiKey: API_KEY };
  server.secrets.set(TOKEN_REF, { login: LOGIN, apiKey: API_KEY });
  const egress = new TimedEgress(server, clock);
  const store = new InMemoryOdooStore();
  const directory = new InMemoryChannelDirectory();
  directory.addTarget(STORE_A, TARGET_A, "odoo.shop-a.com");
  directory.addTarget(STORE_B, TARGET_B, "odoo.shop-b.com");
  const secrets = new StaticSecrets();
  secrets.refs.add(TOKEN_REF);
  const flags = new StaticOdooFlags(true);
  const dns = new FakeOdooDns();
  dns.set("odoo.shop-a.com", [PUBLIC_IP]);
  dns.set("odoo.shop-b.com", ["93.184.216.35"]);
  const skus = new InMemorySkuResolver();
  const stock = new RecordingStockSink();
  const prices = new RecordingPriceSink();
  const metrics = new InMemoryOdooMetrics();
  let n = 0;
  const ids = { uuidV7: () => `00000000-0000-7000-8000-${String(++n).padStart(12, "0")}` };
  const transport = new OdooTransport({ egress, dns, directory, clock, sleeper: clock, metrics, pacer: new DomainPacer() });
  const deps: OdooDeps = { store, directory, secrets, flags, transport, skus, stock, prices, metrics, clock, ids };
  const connect = new ConnectOdooChannel(deps);
  const sync = new SyncOdooChannel(deps);
  const h: OdooHarness = {
    server,
    egress,
    store,
    directory,
    secrets,
    flags,
    dns,
    skus,
    stock,
    prices,
    metrics,
    clock,
    deps,
    connect,
    disconnect: new DisconnectOdooChannel(deps),
    test: new TestOdooConnection(deps),
    sync,
    batch: new RunOdooPollBatch(deps, sync),
    async connectA(o = {}) {
      const r = await connect.execute({
        storeId: STORE_A,
        targetId: TARGET_A,
        database: server.database,
        tokenRef: TOKEN_REF,
        kmsKeyRef: KMS_REF,
        pricelistId: o.pricelistId ?? null,
        stockLocationId: o.stockLocationId ?? null,
        pollIntervalSeconds: o.pollIntervalSeconds ?? 900,
      });
      if (r.kind !== "connected") throw new Error(`connect failed: ${r.kind}`);
      return r.config.channelId;
    },
  };
  return h;
}

export const seedCatalog = (h: OdooHarness): void => {
  h.server.products = [
    { id: 101, default_code: "DRS-001", list_price: 1500, write_date: "2026-10-01 09:00:00", product_tmpl_id: 11 },
    { id: 102, default_code: "TOP-002", list_price: 799.5, write_date: "2026-10-01 09:00:00", product_tmpl_id: 12 },
    { id: 103, default_code: "UNMAPPED-9", list_price: 100, write_date: "2026-10-01 09:00:00", product_tmpl_id: 13 },
    { id: 104, default_code: false, list_price: 100, write_date: "2026-10-01 09:00:00", product_tmpl_id: 14 },
  ];
  h.server.quants = [
    { product_id: 101, quantity: 10, reserved_quantity: 3, write_date: "2026-10-05 10:00:00", locationId: 8, locationPath: [1, 8], locationUsage: "internal" },
    { product_id: 101, quantity: 4, reserved_quantity: 0, write_date: "2026-10-06 10:00:00", locationId: 9, locationPath: [1, 9], locationUsage: "internal" },
    { product_id: 101, quantity: 500, reserved_quantity: 0, write_date: "2026-10-07 10:00:00", locationId: 20, locationPath: [20], locationUsage: "customer" },
    { product_id: 102, quantity: 2.7, reserved_quantity: 0, write_date: "2026-10-04 10:00:00", locationId: 8, locationPath: [1, 8], locationUsage: "internal" },
  ];
  h.skus.add(STORE_A, "DRS-001", SKU(1));
  h.skus.add(STORE_A, "TOP-002", SKU(2));
  // A different store's SKU for the same seller code must never be reachable from store A.
  h.skus.add(STORE_B, "UNMAPPED-9", SKU(99));
};
