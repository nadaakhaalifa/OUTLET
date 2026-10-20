import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor, BrandRole } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import { FakeBackgroundRemoval, FakeProductMediaBlobs, InMemoryProductMediaStore, StaticProductMediaFlags } from "../adapters/in-memory";
import { FLAG_BACKGROUND_REMOVAL } from "../domain/ports";
import { DEFAULT_PRODUCT_MEDIA_CONFIG, type ProductMediaConfig } from "../application/shared";
import { ProductMediaModule } from "../product-media.module";

export const NOW_MS = Date.parse("2026-10-12T10:00:00Z");
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const STORE_A = "00000000-0000-4000-a000-000000000001";
export const STORE_B = "00000000-0000-4000-a000-000000000002";

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
  add(token: string, subject: Subject): void {
    this.subjects.set(token, subject);
  }
  async authenticate(bearer: string, nowMs: number) {
    const s = this.subjects.get(bearer);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = {
      iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `jti-${bearer}`, sid: `sid-${bearer}`, amr: ["otp_sms"],
    };
    return { actor: s.actor, claims };
  }
}

const shopperActor = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });
const sellerActor = (id: string, storeId: string, role: BrandRole, o: Partial<Pick<Actor, "status" | "tokenScopes">> = {}): Actor => ({
  id,
  status: o.status ?? "active",
  assurance: "basic",
  grants: [{ kind: "brand", storeId, role }],
  tokenScopes: o.tokenScopes ?? ["seller:read", "seller:write"],
});

export const TOKENS = {
  ownerA: "token-pm-owner-a-00000000001",
  managerA: "token-pm-manager-a-000000002",
  warehouseA: "token-pm-warehouse-a-0000003",
  catalogA: "token-pm-catalog-a-000000004",
  financeA: "token-pm-finance-a-000000005",
  supportA: "token-pm-support-a-000000006",
  ownerB: "token-pm-owner-b-00000000007",
  suspendedA: "token-pm-suspended-a-0000008",
  noScopeA: "token-pm-noscope-a-00000009",
  shopper: "token-pm-shopper-0000000010",
  buyerAudSeller: "token-pm-buyer-aud-0000000011",
};

export interface MediaHarness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryProductMediaStore;
  readonly blobs: FakeProductMediaBlobs;
  readonly removal: FakeBackgroundRemoval;
  readonly flags: StaticProductMediaFlags;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
}

export async function createMediaHarness(cfg: Partial<ProductMediaConfig> = {}): Promise<MediaHarness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.ownerA, { actor: sellerActor(U(11), STORE_A, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.managerA, { actor: sellerActor(U(12), STORE_A, "manager"), aud: "seller_api" });
  tokens.add(TOKENS.warehouseA, { actor: sellerActor(U(13), STORE_A, "warehouse"), aud: "seller_api" });
  tokens.add(TOKENS.catalogA, { actor: sellerActor(U(14), STORE_A, "catalog"), aud: "seller_api" });
  tokens.add(TOKENS.financeA, { actor: sellerActor(U(15), STORE_A, "finance"), aud: "seller_api" });
  tokens.add(TOKENS.supportA, { actor: sellerActor(U(16), STORE_A, "support"), aud: "seller_api" });
  tokens.add(TOKENS.ownerB, { actor: sellerActor(U(17), STORE_B, "owner"), aud: "seller_api" });
  tokens.add(TOKENS.suspendedA, { actor: sellerActor(U(18), STORE_A, "owner", { status: "suspended" }), aud: "seller_api" });
  tokens.add(TOKENS.noScopeA, { actor: sellerActor(U(19), STORE_A, "owner", { tokenScopes: [] }), aud: "seller_api" });
  tokens.add(TOKENS.shopper, { actor: shopperActor(U(1)), aud: "seller_api" });
  tokens.add(TOKENS.buyerAudSeller, { actor: sellerActor(U(11), STORE_A, "owner"), aud: "buyer_api" });

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryProductMediaStore();
  const blobs = new FakeProductMediaBlobs();
  const removal = new FakeBackgroundRemoval();
  const flags = new StaticProductMediaFlags(new Set([FLAG_BACKGROUND_REMOVAL]));
  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      ProductMediaModule.forRoot(config, { store, blobs, removal, flags, config: { ...DEFAULT_PRODUCT_MEDIA_CONFIG, ...cfg } }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, clock, store, blobs, removal, flags, http: () => request(app.getHttpServer()), close: () => app.close() };
}

export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });
let idem = 0;
export const idemKey = (): Record<string, string> => ({ "Idempotency-Key": `00000000-0000-7000-8000-${String(++idem).padStart(12, "0")}` });

/** A minimal valid PNG (1x1) so the module's own sanitizer accepts it. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"),
);
