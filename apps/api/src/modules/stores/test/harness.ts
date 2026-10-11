import "reflect-metadata";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../../../app.module";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { createIdGenerator, nodeCsprng } from "../../../platform";
import { FakeClock, login, type Harness, type LoggedIn } from "../../../test/harness";
import { DEV_ATTESTATION_PREFIX, AGE_GATE, AGE_GATE_STORE, DEV_OTP_MAILBOX, AUTH_EVENTS, type AgeGate, type DevOtpMailbox, type InMemoryAgeGateStore, type InMemoryAuthEventPublisher } from "../../auth";
import { AUDIT_SINK, type InMemoryAuditSink } from "../../../platform";
import type { StoresModuleOptions } from "../stores.module";

export interface StoresHarness extends Harness {
  readonly loginAs: (phone: string) => Promise<LoggedIn>;
}

/** Same wiring as test/harness.ts plus the stores module (the integrator registers it in AppModule later). */
export async function createStoresHarness(options: StoresModuleOptions = {}): Promise<StoresHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule.register(config, { clock, ids }, { stores: options })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const ageGate = app.get<AgeGate>(AGE_GATE, { strict: false });
  const ageGateStore = app.get<InMemoryAgeGateStore>(AGE_GATE_STORE, { strict: false });
  const grantAgeGate = (attestKeyId: string): void =>
    ageGateStore.grantPassForTest(ageGate.passKeyFor(attestKeyId), clock.nowMs() + 365 * 86_400_000);
  grantAgeGate("key-device-1");
  const h: Harness = {
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
  return { ...h, loginAs: (phone) => login(h, phone) };
}

export { DEV_ATTESTATION_PREFIX };
