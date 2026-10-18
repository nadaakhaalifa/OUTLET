import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import { FakeBannerImageUrls, InMemoryHomeBannerStore, RecordingBannerAudit, StaticBannerFlags } from "../adapters/in-memory";
import { FLAG_HOME_BANNERS } from "../domain/ports";
import { HomeBannersModule } from "../home-banners.module";

export const NOW_MS = Date.parse("2026-10-12T10:00:00Z");
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export class FakeClock implements Clock {
  constructor(private ms = NOW_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

interface Subject {
  readonly actor: Actor;
  readonly aud: AccessClaims["aud"];
}
class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, Subject>();
  add(token: string, s: Subject): void {
    this.subjects.set(token, s);
  }
  async authenticate(bearer: string, nowMs: number) {
    const s = this.subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}

const admin = (id: string, role: "marketing" | "ops" | "support" | "finance", o: Partial<Pick<Actor, "assurance" | "status">> = {}): Actor => ({
  id,
  status: o.status ?? "active",
  assurance: o.assurance ?? "passkey",
  grants: [{ kind: "admin", role }],
  tokenScopes: ["admin:access"],
});

export const TOKENS = {
  marketing: "token-hb-marketing-0000000001",
  ops: "token-hb-ops-0000000000000002",
  support: "token-hb-support-00000000003",
  finance: "token-hb-finance-00000000004",
  noPasskey: "token-hb-nopasskey-00000000005",
  shopper: "token-hb-shopper-0000000000006",
  sellerOnAdmin: "token-hb-seller-0000000000007",
  adminOnShopper: "token-hb-admin-on-shopper-08",
};

export interface BannerHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryHomeBannerStore;
  readonly audit: RecordingBannerAudit;
  readonly flags: StaticBannerFlags;
  /** `flag.guest_browsing` (platform gate). Default blocked, like production. */
  readonly guest: { on: boolean };
  /** `kill.public_catalog` (platform gate). Default allowed in tests. */
  readonly publicCatalog: { on: boolean };
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createBannerHarness(): Promise<BannerHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.marketing, { actor: admin(U(21), "marketing"), aud: "admin_api" });
  tokens.add(TOKENS.ops, { actor: admin(U(22), "ops"), aud: "admin_api" });
  tokens.add(TOKENS.support, { actor: admin(U(23), "support"), aud: "admin_api" });
  tokens.add(TOKENS.finance, { actor: admin(U(24), "finance"), aud: "admin_api" });
  tokens.add(TOKENS.noPasskey, { actor: admin(U(25), "marketing", { assurance: "basic" }), aud: "admin_api" });
  tokens.add(TOKENS.shopper, { actor: { id: U(1), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] }, aud: "buyer_api" });
  tokens.add(TOKENS.sellerOnAdmin, {
    actor: { id: U(31), status: "active", assurance: "passkey", grants: [{ kind: "brand", storeId: U(700), role: "owner" }], tokenScopes: ["seller:read", "seller:write"] },
    aud: "seller_api",
  });
  tokens.add(TOKENS.adminOnShopper, { actor: admin(U(21), "marketing"), aud: "admin_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryHomeBannerStore();
  const audit = new RecordingBannerAudit();
  const flags = new StaticBannerFlags(new Set([FLAG_HOME_BANNERS]));
  const guest = { on: false };
  const publicCatalog = { on: true };
  const moduleRef = await Test.createTestingModule({
    imports: [PlatformModule.forRoot(config, { clock, ids, guestBrowsingGate: { enabled: async () => guest.on }, publicReadGate: { enabled: async () => publicCatalog.on } }), TestAuthModule.register(), HomeBannersModule.forRoot(config, { store, audit, flags, images: new FakeBannerImageUrls() })],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, clock, store, audit, flags, guest, publicCatalog, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
let idem = 0;
export const idemKey = (): Record<string, string> => ({ "Idempotency-Key": `00000000-0000-7000-8000-${String(++idem).padStart(12, "0")}` });
