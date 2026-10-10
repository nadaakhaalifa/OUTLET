import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import {
  AGE_GATE,
  AGE_GATE_STORE,
  AUTH_EVENTS,
  AuthModule,
  DEV_OTP_MAILBOX,
  type AgeGate,
  type DevOtpMailbox,
  type InMemoryAgeGateStore,
  type InMemoryAuthEventPublisher,
} from "../../auth";
import {
  AUDIT_SINK,
  PlatformModule,
  createIdGenerator,
  nodeCsprng,
  type InMemoryAuditSink,
} from "../../../platform";
import { FakeClock, type Harness } from "../../../test/harness";
import { CartModule } from "../cart.module";
import { FakeCatalog } from "../adapters/fake-catalog";
import {
  InMemoryCartEventPublisher,
  InMemoryCartRepository,
  StaticMembership,
  StaticPlatformConfig,
} from "../adapters/in-memory";

export interface CartHarness extends Harness {
  readonly catalog: FakeCatalog;
  readonly membership: StaticMembership;
  readonly platformConfig: StaticPlatformConfig;
  readonly repo: InMemoryCartRepository;
  readonly cartEvents: InMemoryCartEventPublisher;
}

/** Own Nest testing module: platform + auth (for login) + cart only. No AppModule coupling. */
export async function createCartHarness(): Promise<CartHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const catalog = new FakeCatalog();
  const membership = new StaticMembership();
  const platformConfig = new StaticPlatformConfig();
  const repo = new InMemoryCartRepository();
  const cartEvents = new InMemoryCartEventPublisher();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      AuthModule.forRoot(config),
      CartModule.forRoot(config, { catalog, membership, platformConfig, repository: repo, events: cartEvents }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const ageGate = app.get<AgeGate>(AGE_GATE, { strict: false });
  const ageGateStore = app.get<InMemoryAgeGateStore>(AGE_GATE_STORE, { strict: false });
  const grantAgeGate = (attestKeyId: string): void =>
    ageGateStore.grantPassForTest(ageGate.passKeyFor(attestKeyId), clock.nowMs() + 365 * 86_400_000);
  grantAgeGate("key-device-1");
  return {
    app,
    clock,
    config,
    events: app.get<InMemoryAuthEventPublisher>(AUTH_EVENTS, { strict: false }),
    ageGateStore,
    grantAgeGate,
    mailbox: app.get<DevOtpMailbox>(DEV_OTP_MAILBOX, { strict: false }),
    audit: app.get<InMemoryAuditSink>(AUDIT_SINK, { strict: false }),
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
    catalog,
    membership,
    platformConfig,
    repo,
    cartEvents,
  };
}

let seq = 0;
/** Valid UUIDv7-shaped id, unique per call. */
export function uid(prefix = 0): string {
  seq += 1;
  return `0192f3a4-5b6c-7d8e-9f01-${String(prefix * 1_000_000 + seq).padStart(12, "0")}`;
}

export const EGP = (pounds: bigint) => ({ amount: pounds * 100n, currency: "EGP" as const });
