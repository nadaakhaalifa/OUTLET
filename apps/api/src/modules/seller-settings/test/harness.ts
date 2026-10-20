import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import {
  DomainNameMatch,
  FakeEtaVerifier,
  FakeFieldCipher,
  FakeMemberships,
  FakeStoreIdentity,
  FakeStrongFactor,
  FakeUploadScan,
  FakeUploadStore,
  RecordingInviteDelivery,
  StaticLimits,
} from "../adapters/fakes";
import { InMemorySettingsRepository } from "../adapters/in-memory";
import { SellerSettingsModule } from "../seller-settings.module";

export const U = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
export const STORE_A = U(0xa0);
export const STORE_B = U(0xb0);

export class TestClock {
  ms = 1_790_000_000_000;
  nowMs(): number {
    return this.ms;
  }
}

class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
  add(token: string, actor: Actor, aud: AccessClaims["aud"] = "seller_api"): void {
    this.subjects.set(token, { actor, aud });
  }
  async authenticate(bearer: string, nowMs: number) {
    const s = this.subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}

export const seller = (id: string, storeId: string, role: BrandRole, scopes: string[] = ["seller:read", "seller:write"]): Actor => ({
  id,
  status: "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: scopes,
});
export const plainUser = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });

export interface Harness {
  readonly app: INestApplication;
  readonly clock: TestClock;
  readonly tokens: TokenTable;
  readonly repo: InMemorySettingsRepository;
  readonly identity: FakeStoreIdentity;
  readonly uploads: FakeUploadStore;
  readonly scan: FakeUploadScan;
  readonly strong: FakeStrongFactor;
  readonly members: FakeMemberships;
  readonly delivery: RecordingInviteDelivery;
  readonly eta: FakeEtaVerifier;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new TestClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }
  const repo = new InMemorySettingsRepository();
  const identity = new FakeStoreIdentity();
  const uploads = new FakeUploadStore();
  const scan = new FakeUploadScan();
  const strong = new FakeStrongFactor();
  const members = new FakeMemberships();
  const delivery = new RecordingInviteDelivery();
  const eta = new FakeEtaVerifier();
  for (const [id, name] of [
    [STORE_A, "متجر النور"],
    [STORE_B, "متجر الأمل"],
  ] as const) {
    identity.add(id, {
      slug: id === STORE_A ? "nour" : "amal",
      kind: "local",
      nameAr: name,
      nameEn: null,
      verifiedBadge: true,
      legal: { legalName: id === STORE_A ? "شركة النور للملابس" : "Amal Trading", commercialRegisterNo: "12345", taxCardNo: "999-888-777", governorateCode: "EG-C" },
    });
  }
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      SellerSettingsModule.forRoot(config, {
        repository: repo,
        identity,
        uploads,
        scan,
        strongFactor: strong,
        memberships: members,
        delivery,
        eta,
        limits: new StaticLimits(),
        nameMatch: new DomainNameMatch(),
        cipher: new FakeFieldCipher(),
      }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, clock, tokens, repo, identity, uploads, scan, strong, members, delivery, eta, http: () => request(app.getHttpServer()), close: () => app.close() };
}
