import "reflect-metadata";
import { createHash } from "node:crypto";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SELLER_ENROL_SCOPE, type AccessClaims, type Amr } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { FakeBrandDocumentStore, FakeScanPort, FakeVerificationLink, InMemoryBrandApplicationRepository, RecordingFunnel } from "../adapters/in-memory";
import { SELLERS_ADMIN_PORT, SELLERS_SERVICE } from "../adapters/tokens";
import type { BrandApplicationService } from "../application/service";
import type { BrandApplicationsAdminPort, BrandApplicationRepository } from "../domain/ports";
import { SellersModule } from "../sellers.module";
import { TestClock } from "./fixtures";

interface Subject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
  readonly scope?: typeof SELLER_ENROL_SCOPE;
  readonly amr: readonly Amr[];
}

export class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, Subject>();
  add(token: string, s: Subject): string {
    this.subjects.set(token, s);
    return token;
  }
  async authenticate(bearer: string, nowMs: number) {
    const s = this.subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = {
      iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: [...s.amr],
      ...(s.scope !== undefined ? { scope: s.scope } : {}),
    };
    return { actor: s.actor, claims };
  }
}

export const sellerActor = (id: string, status: Actor["status"] = "active"): Actor => ({ id, status, assurance: "basic", grants: [], tokenScopes: [] });

export interface Tokens {
  /** Phone-OTP enrolment token (30 min, scope seller:enrol). */
  enrol(userId: string): string;
  /** Full session without a strong factor (OTP only). */
  weak(userId: string): string;
  /** Full session with a passkey. */
  strong(userId: string): string;
  /** A shopper (buyer_api) token. */
  buyer(userId: string): string;
}

export interface SellersHarness {
  readonly app: INestApplication;
  readonly clock: TestClock;
  readonly repo: BrandApplicationRepository & { outbox: { type: string; payload: unknown }[] };
  readonly store: FakeBrandDocumentStore;
  readonly funnel: RecordingFunnel;
  readonly link: FakeVerificationLink;
  readonly admin: BrandApplicationsAdminPort;
  readonly service: BrandApplicationService;
  readonly tokens: Tokens;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createSellersHarness(): Promise<SellersHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new TestClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const table = new TokenTable();

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: table }], exports: [AUTHENTICATOR] };
    }
  }

  const repo = new InMemoryBrandApplicationRepository();
  const store = new FakeBrandDocumentStore(() => clock.nowMs());
  const funnel = new RecordingFunnel();
  const link = new FakeVerificationLink();
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      SellersModule.forRoot(config, { repository: repo, store, scanner: new FakeScanPort(store), analytics: funnel, verification: link }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const tok = (kind: string, userId: string, s: Omit<Subject, "actor">): string =>
    table.add(`${kind}-${userId}-token-000000`, { actor: sellerActor(userId), ...s });
  return {
    app,
    clock,
    repo,
    store,
    funnel,
    link,
    admin: app.get<BrandApplicationsAdminPort>(SELLERS_ADMIN_PORT, { strict: false }),
    service: app.get<BrandApplicationService>(SELLERS_SERVICE, { strict: false }),
    tokens: {
      enrol: (u) => tok("enrol", u, { aud: "seller_api", scope: SELLER_ENROL_SCOPE, amr: ["otp_sms"] }),
      weak: (u) => tok("weak", u, { aud: "seller_api", amr: ["otp_sms"] }),
      strong: (u) => tok("strong", u, { aud: "seller_api", amr: ["otp_sms", "passkey"] }),
      buyer: (u) => tok("buyer", u, { aud: "buyer_api", amr: ["otp_sms"] }),
    },
    http: () => request(app.getHttpServer()),
    close: () => app.close(),
  };
}

let keyCounter = 0;
/** UUIDv7-shaped client key (the idempotency service requires version 7). */
export const nextKey = (): string => {
  keyCounter += 1;
  const rnd = (n: number): string => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  const ts = Date.now().toString(16).padStart(12, "0");
  return `${ts.slice(0, 8)}-${ts.slice(8)}-7${rnd(3)}-8${rnd(3)}-${(keyCounter.toString(16) + rnd(12)).slice(0, 12).padStart(12, "0")}`;
};
export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
export const pdfBytes = (n = 64): Uint8Array => {
  const b = new Uint8Array(n);
  b.set(new TextEncoder().encode("%PDF-1.7\n"));
  return b;
};
export const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
