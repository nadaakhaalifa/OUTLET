import "reflect-metadata";
import { Global, Module, type DynamicModule, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator, type Clock } from "../../../platform";
import { sanitizeImage } from "../domain/image";
import {
  FakeFaceDetector,
  FakeImageEmbedder,
  FakeImageSafety,
  FakeQueryImageStore,
  FakeShopperContext,
  FakeVisualCatalog,
  FakeVisualConsent,
  InMemoryVisualIndex,
  InMemoryVisualMetrics,
  InMemoryVisualStore,
  StaticVisualFlags,
  VisualSearchModule,
  SWEEP_VISUAL_SEARCH,
  type SweepVisualSearch,
  type VisualCandidate,
  type VisualLimits,
} from "../index";

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

class TokenTable implements Authenticator {
  private readonly subjects = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
  add(token: string, actor: Actor, aud: AccessClaims["aud"]): void {
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

export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const P = (n: number): string => `00000000-0000-4000-8000-${String(7000 + n).padStart(12, "0")}`;
export const S = (n: number): string => `00000000-0000-4000-8000-${String(9000 + n).padStart(12, "0")}`;
export const USERS = { a: U(1), b: U(2) };
export const TOKENS = {
  a: "token-shopper-a-000000000000001",
  b: "token-shopper-b-000000000000002",
  seller: "token-seller-owner-000000000011",
  admin: "token-admin-support-0000000012",
};
export const bearer = (t: string): Record<string, string> => ({ Authorization: `Bearer ${t}` });

const shopper = (id: string): Actor => ({ id, status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] });

export const cand = (n: number, store: number, over: Partial<VisualCandidate> = {}): VisualCandidate => ({
  productId: P(n),
  storeId: S(store),
  world: "local",
  categoryId: "dress",
  priceMinor: 100_000n,
  claimAllowed: false,
  verifiedDiscountPct: 0,
  inStock: true,
  sizesInStock: ["M"],
  storeActive: true,
  minAge: 18,
  colour: null,
  pattern: null,
  ...over,
});

/** A minimal valid JPEG: SOI, APP0, APP1 (EXIF with a GPS marker), COM, SOF0 (w x h), SOS, data, EOI. */
export function jpeg(width: number, height: number, tag = 0, withExif = true): Uint8Array {
  const seg = (m: number, body: number[]): number[] => [0xff, m, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
  const exif = [...Buffer.from("Exif\0\0"), ...Buffer.from("GPSLatitude=30.04N;GPSLongitude=31.23E")];
  const sof = [8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0];
  const bytes = [
    0xff, 0xd8,
    ...seg(0xe0, [...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(withExif ? seg(0xe1, exif) : []),
    ...seg(0xfe, [...Buffer.from("made-by-phone")]),
    ...seg(0xc0, sof),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    tag & 0xff, (tag >> 8) & 0xff, 1, 2, 3, 4,
    0xff, 0xd9,
  ];
  return Uint8Array.from(bytes);
}

export interface Harness {
  readonly app: INestApplication;
  readonly clock: FakeClock;
  readonly store: InMemoryVisualStore;
  readonly images: FakeQueryImageStore;
  readonly embedder: FakeImageEmbedder;
  readonly faces: FakeFaceDetector;
  readonly safety: FakeImageSafety;
  readonly index: InMemoryVisualIndex;
  readonly catalog: FakeVisualCatalog;
  readonly shopper: FakeShopperContext;
  readonly consent: FakeVisualConsent;
  readonly flags: StaticVisualFlags;
  readonly metrics: InMemoryVisualMetrics;
  readonly sweep: SweepVisualSearch;
  http(): ReturnType<typeof request>;
  close(): Promise<void>;
  /** Registers a product with a vector computed from `imageBytes` (as the embeddings pipeline would). */
  addProduct(c: VisualCandidate, imageBytes: Uint8Array): void;
  /** Issues an upload over HTTP, puts the bytes and returns the id. */
  upload(token: string, bytes: Uint8Array, scan?: "clean" | "pending_scan" | "infected"): Promise<string>;
}

export async function createHarness(limits: Partial<VisualLimits> = {}): Promise<Harness> {
  const config = loadConfig({ NODE_ENV: "test" });
  const clock = new FakeClock();
  const ids = createIdGenerator(clock, nodeCsprng);
  const tokens = new TokenTable();
  tokens.add(TOKENS.a, shopper(USERS.a), "buyer_api");
  tokens.add(TOKENS.b, shopper(USERS.b), "buyer_api");
  tokens.add(TOKENS.seller, { id: U(11), status: "active", assurance: "basic", grants: [{ kind: "brand", storeId: S(1), role: "owner" }], tokenScopes: ["seller:read", "seller:write"] }, "seller_api");
  tokens.add(TOKENS.admin, { id: U(12), status: "active", assurance: "passkey", grants: [{ kind: "admin", role: "support" }], tokenScopes: ["admin:access"] }, "admin_api");

  @Global()
  @Module({})
  class TestAuthModule {
    static register(): DynamicModule {
      return { module: TestAuthModule, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }

  const store = new InMemoryVisualStore();
  const images = new FakeQueryImageStore();
  const embedder = new FakeImageEmbedder();
  const faces = new FakeFaceDetector();
  const safety = new FakeImageSafety();
  const index = new InMemoryVisualIndex();
  const catalog = new FakeVisualCatalog();
  const shopperCtx = new FakeShopperContext();
  const consent = new FakeVisualConsent();
  const flags = new StaticVisualFlags(true);
  const metrics = new InMemoryVisualMetrics();

  const moduleRef = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids }),
      TestAuthModule.register(),
      VisualSearchModule.forRoot(config, { store, images, embedder, faces, safety, index, catalog, shopper: shopperCtx, consent, flags, metrics, limits }),
    ],
  }).compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  const http = () => request(app.getHttpServer());
  return {
    app,
    clock,
    store,
    images,
    embedder,
    faces,
    safety,
    index,
    catalog,
    shopper: shopperCtx,
    consent,
    flags,
    metrics,
    sweep: app.get<SweepVisualSearch>(SWEEP_VISUAL_SEARCH, { strict: false }),
    http,
    close: () => app.close(),
    addProduct(c, imageBytes) {
      catalog.add(c);
      // The pipeline embeds the sanitised form, as the query path does.
      const clean = sanitizeImage(imageBytes, { maxBytes: 1 << 30, maxDimension: 1 << 20 });
      index.set(c.productId, embedder.vectorOf(clean.ok ? clean.bytes : imageBytes));
    },
    async upload(token, bytes, scan = "clean") {
      const r = await http().post("/v1/search/visual/uploads").set(bearer(token)).send({ content_type: "image/jpeg", size_bytes: bytes.length });
      if (r.status !== 201) throw new Error(`upload issue failed: ${r.status} ${JSON.stringify(r.body)}`);
      const id = (r.body as { upload_id: string }).upload_id;
      images.put(id, bytes, scan);
      return id;
    },
  };
}
