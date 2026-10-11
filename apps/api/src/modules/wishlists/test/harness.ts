import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import {
  AGE_GATE,
  AGE_GATE_STORE,
  AUTH_EVENTS,
  DEV_OTP_MAILBOX,
  type AgeGate,
  type DevOtpMailbox,
  type InMemoryAgeGateStore,
  type InMemoryAuthEventPublisher,
} from "../../auth";
import { AUDIT_SINK, createIdGenerator, nodeCsprng, type InMemoryAuditSink } from "../../../platform";
import { FakeClock, type Harness } from "../../../test/harness";

/**
 * Same wiring as src/test/harness.ts plus the wishlists module. The integrator registers the
 * module in app.module.ts; until then this harness is how the module is exercised over HTTP.
 */
export async function createWishlistHarness(env: Readonly<Record<string, string>> = {}): Promise<Harness> {
  const config = loadConfig({ NODE_ENV: "test", ...env });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config, { clock, ids })],
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
  };
}
