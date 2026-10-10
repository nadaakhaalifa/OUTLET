import "reflect-metadata";
import { type INestApplication, type Type } from "@nestjs/common";
import { Test, type TestingModuleBuilder } from "@nestjs/testing";
import request from "supertest";
import { AppModule } from "../app.module";
import { configureApp } from "../app.setup";
import { loadConfig, type AppConfig } from "../config/env";
import {
  AGE_GATE,
  AGE_GATE_STORE,
  AUTH_EVENTS,
  DEV_ATTESTATION_PREFIX,
  DEV_OTP_MAILBOX,
  type AgeGate,
  type DevOtpMailbox,
  type InMemoryAgeGateStore,
  type InMemoryAuthEventPublisher,
} from "../modules/auth";
import {
  AUDIT_SINK,
  AUTHENTICATOR,
  type InMemoryAuditSink,
  createIdGenerator,
  nodeCsprng,
  type Authenticator,
  type Clock,
} from "../platform";

export const START_MS = 1_800_000_000_000;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

export interface Harness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly mailbox: DevOtpMailbox;
  readonly audit: InMemoryAuditSink;
  readonly config: AppConfig;
  readonly events: InMemoryAuthEventPublisher;
  readonly ageGateStore: InMemoryAgeGateStore;
  /** Marks an attested device key (the part after the attestation prefix) as having passed the age gate. */
  grantAgeGate(attestKeyId: string): void;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export interface HarnessOptions {
  readonly env?: Readonly<Record<string, string>>;
  readonly controllers?: Type<unknown>[];
  readonly providers?: { provide: unknown; useValue: unknown }[];
  readonly customise?: (b: TestingModuleBuilder) => TestingModuleBuilder;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const config = loadConfig({ NODE_ENV: "test", ...(options.env ?? {}) });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  let builder = Test.createTestingModule({
    imports: [AppModule.register(config, { clock, ids })],
    controllers: options.controllers ?? [],
    providers: (options.providers ?? []) as never[],
  });
  if (options.customise) builder = options.customise(builder);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const ageGate = app.get<AgeGate>(AGE_GATE, { strict: false });
  const ageGateStore = app.get<InMemoryAgeGateStore>(AGE_GATE_STORE, { strict: false });
  const grantAgeGate = (attestKeyId: string): void =>
    ageGateStore.grantPassForTest(ageGate.passKeyFor(attestKeyId), clock.nowMs() + 365 * 86_400_000);
  // The default fixture device used by ATTEST_HEADERS has always "passed" so existing flows keep their shape.
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

export const PHONE = "+201001234567";
export const INSTALL_ID = "0192f3a4-5b6c-4d8e-9f01-23456789abcd";
export const ATTEST_HEADERS = {
  "X-App-Attest": `${DEV_ATTESTATION_PREFIX}key-device-1`,
  "X-Client-Platform": "ios",
} as const;
export const IDEM_KEY_1 = "0192f3a4-5b6c-7d8e-9f01-23456789abc1";
export const IDEM_KEY_2 = "0192f3a4-5b6c-7d8e-9f01-23456789abc2";

export interface LoggedIn {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly challengeId: string;
}

/** Runs the OTP request and verify flow against the dev fixtures. */
export async function login(
  h: Harness,
  phone = PHONE,
  attest: Record<string, string> = {
    "X-App-Attest": `${DEV_ATTESTATION_PREFIX}key-${phone.slice(-8)}`,
    "X-Client-Platform": "ios",
  },
  installId = INSTALL_ID,
): Promise<LoggedIn> {
  const attestKey = attest["X-App-Attest"]?.slice(DEV_ATTESTATION_PREFIX.length);
  if (attestKey !== undefined) h.grantAgeGate(attestKey);
  const sent = await h.http().post("/v1/auth/otp/request").set(attest).send({ phone_e164: phone });
  if (sent.status !== 202) throw new Error(`otp request failed: ${sent.status} ${JSON.stringify(sent.body)}`);
  const code = h.mailbox.last(phone)?.code;
  if (code === undefined) throw new Error("no code in dev mailbox");
  const verified = await h
    .http()
    .post("/v1/auth/otp/verify")
    .set(attest)
    .send({ challenge_id: sent.body.challenge_id, code, device: { platform: "ios", install_id: installId } });
  if (verified.status !== 200) throw new Error(`otp verify failed: ${verified.status} ${JSON.stringify(verified.body)}`);
  const auth = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
  const principal = await auth.authenticate(verified.body.access_token, h.clock.nowMs());
  if (principal === null) throw new Error("issued token does not authenticate");
  return {
    accessToken: verified.body.access_token,
    refreshToken: verified.body.refresh_token,
    userId: verified.body.user.id,
    sessionId: principal.claims.sid,
    challengeId: sent.body.challenge_id,
  };
}
