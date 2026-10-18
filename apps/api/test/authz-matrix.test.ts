/**
 * Machine-checked authorization matrix (master prompt A2.10).
 *
 * Every route registered with the Nest router is discovered from controller metadata and MUST have
 * an entry in MATRIX; a route without an entry (or an entry without a route) fails the suite.
 * For each implemented route the suite asserts:
 *   (a) unauthenticated -> 401 (protected routes) and a problem body that carries no extra fields
 *   (b) wrong audience token -> 401, suspended subject -> 403
 *   (c) another user's object -> 404, indistinguishable from a missing object, and no side effect
 *   (d) successful and failed responses contain only allow-listed fields
 * Also cross-checks docs/api/openapi.yaml and docs/security/authz-matrix.md.
 */
import { createHash, createSign, generateKeyPairSync, type JsonWebKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { DiscoveryService, ModulesContainer } from "@nestjs/core";
import { buildAccessClaims } from "@outlet/auth-core";
import type { Test } from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AUTHZ_META, type AuthzMeta } from "../src/platform/decorators";
import { DEV_ATTESTATION_PREFIX, JWKS_KEY_FETCHER, type JwksKeyFetcher } from "../src/modules/auth";
import { AUTHENTICATOR, type Authenticator } from "../src/platform";
import { createHarness, INSTALL_ID, login, type Harness } from "../src/test/harness";
import { CART_CATALOG, type FakeCatalog } from "../src/modules/cart";
import { CATALOG_DEV_FIXTURES, SEED, type CatalogDevFixtures } from "../src/modules/catalog";
import { INVENTORY_SKU_DIRECTORY, type InMemorySkuDirectory } from "../src/modules/inventory";
import { FIT_CATALOG, ORDER_LINE_FIT, type InMemoryFitCatalog, type InMemoryOrderLines } from "../src/modules/sizing";
import { WISHLIST_CATALOG, type InMemoryCatalogRead } from "../src/modules/wishlists";
import { NOTIFICATION_CONTACTS, SEND_NOTIFICATION, type InMemoryContactPort, type SendNotification } from "../src/modules/notifications";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");

// ---- Fixtures ------------------------------------------------------------------------------

const attest = (keyId: string) => ({ "X-App-Attest": `${DEV_ATTESTATION_PREFIX}${keyId}`, "X-Client-Platform": "ios" });
const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const MISSING_ID = "0192f3a4-5b6c-7d8e-9f01-0000000000ff";

interface TestKey {
  readonly kid: string;
  readonly privateKey: KeyObject;
  readonly jwk: JsonWebKey;
}
function makeKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: publicKey.export({ format: "jwk" }) };
}
const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
function signJwt(key: TestKey, claims: Record<string, unknown>): string {
  const data = `${b64({ alg: "RS256", kid: key.kid, typ: "JWT" })}.${b64(claims)}`;
  return `${data}.${createSign("RSA-SHA256").update(data).sign(key.privateKey).toString("base64url")}`;
}
class FakeJwks implements JwksKeyFetcher {
  readonly keys = new Map<string, JsonWebKey>();
  async getKey(provider: "apple" | "google", kid: string): Promise<JsonWebKey | null> {
    return this.keys.get(`${provider}:${kid}`) ?? null;
  }
}
const jwks = new FakeJwks();
const appleKey = makeKey("apple-key-1");
const googleKey = makeKey("google-key-1");
jwks.keys.set("apple:apple-key-1", appleKey.jwk);
jwks.keys.set("google:google-key-1", googleKey.jwk);

// ---- Problem body allow-list ---------------------------------------------------------------

/** Keys a problem body may carry. Extensions are listed per code below. */
const PROBLEM_KEYS = ["type", "title", "status", "detail", "code", "request_id", "errors", "blocked_until", "attempts_remaining", "purpose", "current_policy_version"];

// ---- Matrix --------------------------------------------------------------------------------

interface Ctx {
  readonly h: Harness;
  readonly a: Session;
  readonly b: Session;
}
interface Session {
  readonly token: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly refresh: string;
}

interface Entry {
  /** What the route's decorator must say; checked against the discovered metadata. */
  readonly authz: "public" | "self" | "resource";
  /** Issues the request. `token` null means no Authorization header. `owned` selects own vs foreign object. */
  readonly send: (c: Ctx, token: string | null, target?: "own" | "foreign" | "missing") => Test;
  /** Route takes an object id owned by a user. */
  readonly objectId?: boolean;
  /** Allowed top-level keys of a 2xx JSON body (empty for 204). */
  readonly okKeys: readonly string[];
  /** Fully qualified happy-path status for the owner. */
  readonly okStatus: number;
  /** Optional: prepare per-call state and return the send function result (for single-use credentials). */
  readonly prepare?: (c: Ctx, token: string) => Promise<() => Test>;
  /** The happy path revokes the caller's own session, so it runs on a throwaway user. */
  readonly consumesSession?: boolean;
  /** Seller Center routes use a seller_api staff token instead of the shopper token. */
  readonly aud?: "seller_api";
}

const auth = (t: string | null): Record<string, string> => (t === null ? {} : bearer(t));
const ENTRY_ATTEST = attest("key-matrix-device");

const USER_KEYS = ["id", "phone_masked", "email", "locale", "age_band", "limited_capacity", "phone_verified", "status", "created_at"];

const MATRIX: Record<string, Entry> = {
  "GET /v1/health": {
    authz: "public",
    okStatus: 200,
    okKeys: ["status"],
    send: (c) => c.h.http().get("/v1/health"),
  },
  "GET /v1/ready": {
    authz: "public",
    okStatus: 200,
    okKeys: ["status", "checks"],
    send: (c) => c.h.http().get("/v1/ready"),
  },
  "POST /v1/auth/otp/request": {
    authz: "public",
    okStatus: 202,
    okKeys: ["challenge_id", "expires_at", "resend_available_at", "attempts_remaining", "channel"],
    send: (c) => c.h.http().post("/v1/auth/otp/request").set(ENTRY_ATTEST).send({ phone_e164: `+2010099${String(Math.floor(Math.random() * 90000) + 10000)}` }),
  },
  "POST /v1/auth/otp/verify": {
    authz: "public",
    okStatus: 422,
    okKeys: ["type", ...PROBLEM_KEYS],
    send: (c) =>
      c.h
        .http()
        .post("/v1/auth/otp/verify")
        .set(ENTRY_ATTEST)
        .send({ challenge_id: MISSING_ID, code: "000000", device: { platform: "ios", install_id: INSTALL_ID } }),
  },
  "POST /v1/auth/age-gate": {
    authz: "public",
    okStatus: 200,
    okKeys: ["status", "expires_at"],
    send: (c) =>
      c.h
        .http()
        .post("/v1/auth/age-gate")
        .set(attest("key-matrix-agegate"))
        .send({ dob: "1990-05-17", device_id_hash: createHash("sha256").update("device:key-matrix-agegate").digest("hex") }),
  },
  "POST /v1/auth/apple": {
    authz: "public",
    okStatus: 401,
    okKeys: PROBLEM_KEYS,
    send: (c) =>
      c.h
        .http()
        .post("/v1/auth/apple")
        .set(ENTRY_ATTEST)
        .send({ id_token: "x".repeat(40), nonce: "nonce-matrix-1", device: { platform: "ios", install_id: INSTALL_ID } }),
  },
  "POST /v1/auth/google": {
    authz: "public",
    okStatus: 200,
    okKeys: ["access_token", "access_expires_at", "refresh_token", "refresh_expires_at", "second_factor_required", "user"],
    send: (c) => {
      c.h.grantAgeGate("key-matrix-google");
      const nonce = `nonce-matrix-${Math.random().toString(36).slice(2)}`;
      const now = Math.floor(c.h.clock.nowMs() / 1000);
      const sub = `matrix-google-${nonce}`;
      return c.h
        .http()
        .post("/v1/auth/google")
        .set(attest("key-matrix-google"))
        .send({
          id_token: signJwt(googleKey, {
            iss: "https://accounts.google.com",
            aud: "outletnk-ios.apps.googleusercontent.com",
            sub,
            iat: now,
            exp: now + 3000,
            nonce,
            email: "m@example.com",
            email_verified: true,
          }),
          nonce,
          device: { platform: "ios", install_id: INSTALL_ID },
        });
    },
  },
  "POST /v1/auth/passkey/assert/options": {
    authz: "public",
    okStatus: 200,
    okKeys: ["challenge_id", "challenge", "rp_id", "expires_at"],
    send: (c) => c.h.http().post("/v1/auth/passkey/assert/options").send({}),
  },
  "POST /v1/auth/passkey/assert": {
    authz: "public",
    okStatus: 401,
    okKeys: PROBLEM_KEYS,
    send: (c) =>
      c.h
        .http()
        .post("/v1/auth/passkey/assert")
        .set(ENTRY_ATTEST)
        .send({
          challenge_id: MISSING_ID,
          credential: { id: "nope" },
          device: { platform: "ios", install_id: INSTALL_ID },
        }),
  },
  "POST /v1/auth/refresh": {
    authz: "public",
    okStatus: 401,
    okKeys: PROBLEM_KEYS,
    send: (c) => c.h.http().post("/v1/auth/refresh").send({ refresh_token: "r".repeat(32), device_install_id: INSTALL_ID }),
  },
  "POST /v1/auth/passkey/register/options": {
    authz: "self",
    okStatus: 200,
    okKeys: ["challenge_id", "challenge", "rp_id", "expires_at"],
    send: (c, t) => c.h.http().post("/v1/auth/passkey/register/options").set(auth(t)).send({}),
  },
  "POST /v1/auth/passkey/register": {
    authz: "self",
    okStatus: 422,
    okKeys: PROBLEM_KEYS,
    // A well-formed challenge id nobody issued: 422 for the caller, 401 without a token.
    send: (c, t) =>
      c.h.http().post("/v1/auth/passkey/register").set(auth(t)).send({ challenge_id: MISSING_ID, credential: { id: "cred-x" } }),
  },
  "POST /v1/auth/logout": {
    authz: "self",
    okStatus: 204,
    okKeys: [],
    send: (c, t) => c.h.http().post("/v1/auth/logout").set(auth(t)).send({}),
    consumesSession: true,
  },
  "GET /v1/me": {
    authz: "self",
    okStatus: 200,
    okKeys: ["id", "locale", "age_band", "limited_capacity", "phone_verified", "status", "created_at"],
    send: (c, t) => c.h.http().get("/v1/me").set(auth(t)),
  },
  "GET /v1/me/sessions": {
    authz: "self",
    okStatus: 200,
    okKeys: ["items", "page"],
    send: (c, t) => c.h.http().get("/v1/me/sessions").set(auth(t)),
  },
  "GET /v1/me/sessions/:sessionId": {
    authz: "resource",
    objectId: true,
    okStatus: 200,
    okKeys: ["id", "platform", "created_at", "last_seen_at", "current"],
    send: (c, t, target = "own") =>
      c.h.http().get(`/v1/me/sessions/${pick(c, target)}`).set(auth(t)),
  },
  "DELETE /v1/me/sessions/:sessionId": {
    authz: "resource",
    objectId: true,
    consumesSession: true,
    okStatus: 204,
    okKeys: [],
    send: (c, t, target = "own") => c.h.http().delete(`/v1/me/sessions/${pick(c, target)}`).set(auth(t)),
  },
  "GET /v1/me/privacy/consents": {
    authz: "self",
    okStatus: 200,
    okKeys: ["consents"],
    send: (c, t) => c.h.http().get("/v1/me/privacy/consents").set(auth(t)),
  },
  "PATCH /v1/me/privacy/consents": {
    authz: "self",
    okStatus: 422,
    okKeys: PROBLEM_KEYS,
    send: (c, t) =>
      c.h
        .http()
        .patch("/v1/me/privacy/consents")
        .set(auth(t))
        .send({ changes: [{ purpose: "analytics", granted: true, policy_version: "1" }, { purpose: "analytics", granted: false, policy_version: "1" }] }),
  },
};

// ---- Modules registered in Phase 1 wave 1 ---------------------------------------------------

const uid = (n: number): string => `0192f3a4-5b6c-7d8e-9f01-${String(n).padStart(12, "0")}`;
const SELLER_STORE_1 = uid(0x5001);
const SELLER_STORE_2 = uid(0x5002);
const SELLER_TOKEN = "matrix-seller-owner-store-1";
const SELLER_TOKEN_2 = "matrix-seller-owner-store-2";
const P_DRESS = uid(0xa1);
const P_SHOES = uid(0xa2);
const UP_IMG = uid(0xa0001);
const UP_IMG_2 = uid(0xb0001);
const UP_CSV = uid(0xc0001);
const CSV_HEADER =
  "product_ref,title_ar,title_en,description_ar,category_slug,brand_slug,condition,size_label,color,seller_sku,barcode_gtin,price_egp,initial_stock,image_upload_ids,defect_photo_upload_ids";
let seq = 0x700000;
const idem = (): Record<string, string> => ({ "Idempotency-Key": uid(++seq) });
const EGP = (n: bigint) => ({ amount: n, currency: "EGP" as const });

/** Ids prepared in beforeAll. Foreign objects belong to user b or to seller store 2. */
const FX = {
  wlA: "",
  wlB: "",
  itemA: "",
  lineA: "",
  lineB: "",
  cartStore: uid(0x6001),
  profA: "",
  profB: "",
  product: "",
  productForeign: "",
  imp: "",
  impForeign: "",
  sku: uid(0x8001),
  skuForeign: uid(0x8002),
  stores: [] as string[],
  favStore: "",
  foreignFavStore: "",
  lineFeedbackA: uid(0x9001),
  lineFeedbackB: uid(0x9002),
  fitProduct: uid(0x9101),
  inboxA: "",
  inboxB: "",
};

const sellerBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  title: { ar: "فستان كتان أبيض", en: "White linen dress" },
  description: { ar: "فستان صيفي خفيف" },
  category_id: SEED.categoryDresses,
  brand_id: SEED.brandAcme,
  condition: "new_with_tags",
  image_upload_ids: [UP_IMG],
  skus: [{ size_label: "M", color: "White", price: { amount: "129900", currency: "EGP" }, initial_stock: 4, seller_sku: `LD-${seq++}` }],
  ...over,
});
const PRODUCT_KEYS = [
  "id", "status", "title", "description", "category_id", "brand_id", "condition", "department", "publish_warnings", "material", "image_upload_ids",
  "image_media_job_ids", "defect_photo_upload_ids", "size_chart_id", "skus", "price_claim_state", "updated_at",
];
const IMPORT_KEYS = ["id", "status", "dry_run", "rows_total", "rows_ok", "rows_failed", "error_report_url", "created_at"];
const CART_KEYS = ["id", "groups", "line_count", "updated_at"];
const WISHLIST_KEYS = ["id", "intent", "title", "target_date", "budget", "cool_off_enabled", "visibility", "gift_for", "items", "item_count", "price_hidden", "shared", "share", "created_at", "updated_at", "hide_prices_from_owner", "version"];
const PROFILE_KEYS = ["id", "label", "kind", "fit_preference", "modest_fit", "measurements", "usual_size", "quick_start", "updated_at", "created_at", "version"];
const sizeProfileBody = { label: "Me", kind: "me" };
const TOPS_ROWS = [
  { size_label: "S", measurements: { bust_cm: 86, waist_cm: 68 } },
  { size_label: "M", measurements: { bust_cm: 90, waist_cm: 72 } },
  { size_label: "L", measurements: { bust_cm: 96, waist_cm: 78 } },
];

const tok = (t: string | null) => auth(t);
const pickId = (target: "own" | "foreign" | "missing", own: string, foreign: string): string =>
  target === "own" ? own : target === "foreign" ? foreign : MISSING_ID;
const etagOf = async (c: Ctx, url: string, t: string): Promise<string> =>
  String((await c.h.http().get(url).set(tok(t))).headers["etag"]);

const MODULE_ENTRIES: Record<string, Entry> = {
  // ---- stores ----
  "GET /v1/stores": {
    authz: "self", okStatus: 200, okKeys: ["items", "page", "hint"],
    send: (c, t) => c.h.http().get("/v1/stores?world=everything").set(tok(t)),
  },
  "GET /v1/stores/:storeId": {
    authz: "self", okStatus: 200,
    okKeys: ["id", "slug", "name", "kind", "logo_url", "cover_url", "verified_badge", "max_verified_discount_pct", "rating", "rating_count", "follower_count", "live_drop", "is_favorite", "description", "legal_identity", "free_delivery_threshold", "status", "health_badge"],
    send: (c, t) => c.h.http().get(`/v1/stores/${FX.stores[0] ?? MISSING_ID}`).set(tok(t)),
  },
  "GET /v1/me/favorite-stores": {
    authz: "self", okStatus: 200, okKeys: ["stores", "hidden"],
    send: (c, t) => c.h.http().get("/v1/me/favorite-stores").set(tok(t)),
  },
  "PUT /v1/me/favorite-stores": {
    authz: "self", okStatus: 200, okKeys: ["stores", "hidden"],
    send: (c, t) => c.h.http().put("/v1/me/favorite-stores").set(tok(t)).set("If-Match", '"x"').send({ store_ids: [FX.favStore] }),
    prepare: async (c, t) => {
      const etag = await etagOf(c, "/v1/me/favorite-stores", t);
      return () => c.h.http().put("/v1/me/favorite-stores").set(tok(t)).set("If-Match", etag).send({ store_ids: [FX.favStore] });
    },
  },
  "GET /v1/me/favorite-stores/new-counts": {
    authz: "self", okStatus: 200, okKeys: ["counts"],
    send: (c, t) => c.h.http().get("/v1/me/favorite-stores/new-counts").set(tok(t)),
  },
  "POST /v1/me/favorite-stores/:storeId/seen": {
    authz: "self", objectId: true, okStatus: 204, okKeys: [],
    send: (c, t, target = "own") =>
      c.h.http().post(`/v1/me/favorite-stores/${pickId(target, FX.favStore, FX.foreignFavStore)}/seen`).set(tok(t)),
  },

  // ---- wishlists ----
  "GET /v1/me/wishlists": {
    authz: "self", okStatus: 200, okKeys: ["items", "page"],
    send: (c, t) => c.h.http().get("/v1/me/wishlists").set(tok(t)),
  },
  "POST /v1/me/wishlists": {
    authz: "self", okStatus: 201, okKeys: WISHLIST_KEYS,
    send: (c, t) => c.h.http().post("/v1/me/wishlists").set(tok(t)).send({ intent: "need", title: "قائمة" }),
  },
  "GET /v1/me/wishlists/:wishlistId": {
    authz: "resource", objectId: true, okStatus: 200, okKeys: WISHLIST_KEYS,
    send: (c, t, target = "own") => c.h.http().get(`/v1/me/wishlists/${pickId(target, FX.wlA, FX.wlB)}`).set(tok(t)),
  },
  "PATCH /v1/me/wishlists/:wishlistId": {
    authz: "resource", objectId: true, okStatus: 200, okKeys: WISHLIST_KEYS,
    send: (c, t, target = "own") =>
      c.h.http().patch(`/v1/me/wishlists/${pickId(target, FX.wlA, FX.wlB)}`).set(tok(t)).set("If-Match", "*").send({ title: "جديد" }),
  },
  "DELETE /v1/me/wishlists/:wishlistId": {
    authz: "resource", objectId: true, okStatus: 204, okKeys: [],
    send: (c, t, target = "own") => c.h.http().delete(`/v1/me/wishlists/${pickId(target, FX.wlA, FX.wlB)}`).set(tok(t)),
    prepare: async (c, t) => {
      const r = await c.h.http().post("/v1/me/wishlists").set(tok(t)).send({ intent: "need", title: "مؤقتة" });
      return () => c.h.http().delete(`/v1/me/wishlists/${String(r.body.id)}`).set(tok(t));
    },
  },
  "POST /v1/wishlists/:wishlistId/items": {
    authz: "resource", objectId: true, okStatus: 201, okKeys: ["id", "product", "sku_pref", "added_price", "note", "created_at", "available", "added_at", "price_change", "sku_pref_id", "product_id", "state", "current_price", "cool_off_until"],
    send: (c, t, target = "own") =>
      c.h.http().post(`/v1/wishlists/${pickId(target, FX.wlA, FX.wlB)}/items`).set(tok(t)).send({ product_id: P_SHOES }),
  },
  "DELETE /v1/wishlists/:wishlistId/items/:itemId": {
    authz: "resource", objectId: true, okStatus: 204, okKeys: [],
    send: (c, t, target = "own") =>
      c.h.http().delete(`/v1/wishlists/${pickId(target, FX.wlA, FX.wlB)}/items/${FX.itemA}`).set(tok(t)),
    prepare: async (c, t) => {
      const list = await c.h.http().post("/v1/me/wishlists").set(tok(t)).send({ intent: "need", title: "للحذف" });
      const listId = String(list.body.id);
      const r = await c.h.http().post(`/v1/wishlists/${listId}/items`).set(tok(t)).send({ product_id: P_DRESS });
      return () => c.h.http().delete(`/v1/wishlists/${listId}/items/${String(r.body.id)}`).set(tok(t));
    },
  },
  "POST /v1/me/wishlists/:wishlistId/share": {
    authz: "resource", objectId: true, okStatus: 201, okKeys: ["url", "token", "expires_at", "created_at", "share_url"],
    send: (c, t, target = "own") => c.h.http().post(`/v1/me/wishlists/${pickId(target, FX.wlA, FX.wlB)}/share`).set(tok(t)).send({}),
  },
  "DELETE /v1/me/wishlists/:wishlistId/share": {
    authz: "resource", objectId: true, okStatus: 204, okKeys: [],
    send: (c, t, target = "own") => c.h.http().delete(`/v1/me/wishlists/${pickId(target, FX.wlA, FX.wlB)}/share`).set(tok(t)),
  },
  "GET /v1/shared/wishlists/:token": {
    authz: "public", okStatus: 404, okKeys: PROBLEM_KEYS,
    send: (c) => c.h.http().get(`/v1/shared/wishlists/${"C".repeat(22)}`),
  },

  // ---- cart ----
  "GET /v1/cart": {
    authz: "self", okStatus: 200, okKeys: CART_KEYS,
    send: (c, t) => c.h.http().get("/v1/cart").set(tok(t)),
  },
  "POST /v1/cart/lines": {
    authz: "self", okStatus: 201, okKeys: CART_KEYS,
    send: (c, t) => c.h.http().post("/v1/cart/lines").set(tok(t)).set(idem()).send({ sku_id: FX.sku, qty: 1 }),
    prepare: async (c, t) => {
      const sku = uid(++seq);
      addCartSku(c, sku);
      return () => c.h.http().post("/v1/cart/lines").set(tok(t)).set(idem()).send({ sku_id: sku, qty: 1 });
    },
  },
  "PATCH /v1/cart/lines/:lineId": {
    authz: "resource", objectId: true, okStatus: 200, okKeys: CART_KEYS,
    send: (c, t, target = "own") =>
      c.h.http().patch(`/v1/cart/lines/${pickId(target, FX.lineA, FX.lineB)}`).set(tok(t)).set("If-Match", '"x"').send({ qty: 2 }),
    prepare: async (c, t) => {
      const cart = await c.h.http().get("/v1/cart").set(tok(t));
      const etag = String(cart.headers["etag"]);
      return () => c.h.http().patch(`/v1/cart/lines/${FX.lineA}`).set(tok(t)).set("If-Match", etag).send({ qty: 2 });
    },
  },
  "DELETE /v1/cart/lines/:lineId": {
    authz: "resource", objectId: true, okStatus: 200, okKeys: CART_KEYS,
    send: (c, t, target = "own") => c.h.http().delete(`/v1/cart/lines/${pickId(target, FX.lineA, FX.lineB)}`).set(tok(t)),
    prepare: async (c, t) => {
      const sku = uid(++seq);
      addCartSku(c, sku);
      const r = await c.h.http().post("/v1/cart/lines").set(tok(t)).set(idem()).send({ sku_id: sku, qty: 1 });
      const line = (r.body.groups as { lines: { id: string; sku_id?: string }[] }[]).flatMap((g) => g.lines).at(-1)?.id ?? MISSING_ID;
      return () => c.h.http().delete(`/v1/cart/lines/${line}`).set(tok(t));
    },
  },
  "GET /v1/cart/free-delivery-suggestions": {
    authz: "self", okStatus: 200, okKeys: ["store_id", "remaining", "suggestions"],
    send: (c, t) => c.h.http().get(`/v1/cart/free-delivery-suggestions?store_id=${FX.cartStore}`).set(tok(t)),
  },

  // ---- sizing (shopper) ----
  "GET /v1/me/size-profiles": {
    authz: "self", okStatus: 200, okKeys: ["items", "page"],
    send: (c, t) => c.h.http().get("/v1/me/size-profiles").set(tok(t)),
  },
  "POST /v1/me/size-profiles": {
    authz: "self", okStatus: 201, okKeys: PROFILE_KEYS,
    send: (c, t) => c.h.http().post("/v1/me/size-profiles").set(tok(t)).send(sizeProfileBody),
  },
  "GET /v1/me/size-profiles/:profileId": {
    authz: "self", objectId: true, okStatus: 200, okKeys: PROFILE_KEYS,
    send: (c, t, target = "own") => c.h.http().get(`/v1/me/size-profiles/${pickId(target, FX.profA, FX.profB)}`).set(tok(t)),
  },
  "PATCH /v1/me/size-profiles/:profileId": {
    authz: "self", objectId: true, okStatus: 200, okKeys: PROFILE_KEYS,
    send: (c, t, target = "own") =>
      c.h.http().patch(`/v1/me/size-profiles/${pickId(target, FX.profA, FX.profB)}`).set(tok(t)).set("If-Match", '"x"').send({ label: "New" }),
    prepare: async (c, t) => {
      const etag = await etagOf(c, `/v1/me/size-profiles/${FX.profA}`, t);
      return () => c.h.http().patch(`/v1/me/size-profiles/${FX.profA}`).set(tok(t)).set("If-Match", etag).send({ label: "New" });
    },
  },
  "DELETE /v1/me/size-profiles/:profileId": {
    authz: "self", objectId: true, okStatus: 204, okKeys: [],
    send: (c, t, target = "own") => c.h.http().delete(`/v1/me/size-profiles/${pickId(target, FX.profA, FX.profB)}`).set(tok(t)),
    prepare: async (c, t) => {
      const r = await c.h.http().post("/v1/me/size-profiles").set(tok(t)).send({ label: "Temp", kind: "partner" });
      return () => c.h.http().delete(`/v1/me/size-profiles/${String(r.body.id)}`).set(tok(t));
    },
  },
  "GET /v1/fit/recommend": {
    authz: "self", objectId: true, okStatus: 422, okKeys: PROBLEM_KEYS,
    send: (c, t, target = "own") =>
      c.h.http().get(`/v1/fit/recommend?sku_group=${FX.fitProduct}&profile_id=${pickId(target, FX.profA, FX.profB)}`).set(tok(t)),
  },
  "GET /v1/products/:productId/fit": {
    authz: "self", objectId: true, okStatus: 422, okKeys: PROBLEM_KEYS,
    send: (c, t, target = "own") =>
      c.h.http().get(`/v1/products/${FX.fitProduct}/fit?profile_id=${pickId(target, FX.profA, FX.profB)}`).set(tok(t)),
  },
  "POST /v1/orders/lines/:orderLineId/fit-feedback": {
    authz: "self", objectId: true, okStatus: 204, okKeys: [],
    send: (c, t, target = "own") =>
      c.h.http().post(`/v1/orders/lines/${pickId(target, FX.lineFeedbackA, FX.lineFeedbackB)}/fit-feedback`).set(tok(t)).set(idem()).send({ rating: "ok" }),
  },

  // ---- notifications ----
  "GET /v1/me/notification-preferences": {
    authz: "self", okStatus: 200,
    okKeys: ["push_marketing", "whatsapp_marketing", "sms_marketing", "email_marketing", "quiet_hours", "types", "quiet_hours_start", "quiet_hours_end", "timezone", "locale"],
    send: (c, t) => c.h.http().get("/v1/me/notification-preferences").set(tok(t)),
  },
  "PATCH /v1/me/notification-preferences": {
    authz: "self", okStatus: 200,
    okKeys: ["push_marketing", "whatsapp_marketing", "sms_marketing", "email_marketing", "quiet_hours", "types", "quiet_hours_start", "quiet_hours_end", "timezone", "locale"],
    send: (c, t) => c.h.http().patch("/v1/me/notification-preferences").set(tok(t)).set("If-Match", '"x"').send({ types: [{ type: "PRICE_DROPS", enabled: false }] }),
    prepare: async (c, t) => {
      const etag = await etagOf(c, "/v1/me/notification-preferences", t);
      return () =>
        c.h.http().patch("/v1/me/notification-preferences").set(tok(t)).set("If-Match", etag).send({ types: [{ type: "PRICE_DROPS", enabled: false }] });
    },
  },
  "PUT /v1/me/devices/push-token": {
    authz: "self", okStatus: 204, okKeys: [],
    send: (c, t) => c.h.http().put("/v1/me/devices/push-token").set(tok(t)).send({ install_id: INSTALL_ID, platform: "ios", push_token: "matrix-push-token-1" }),
  },
  "GET /v1/me/notifications": {
    authz: "self", okStatus: 200, okKeys: ["items", "page", "unread_count"],
    send: (c, t) => c.h.http().get("/v1/me/notifications").set(tok(t)),
  },
  "POST /v1/me/notifications/read": {
    authz: "self", objectId: true, okStatus: 204, okKeys: [],
    send: (c, t, target = "own") =>
      c.h.http().post("/v1/me/notifications/read").set(tok(t)).send({ ids: [pickId(target, FX.inboxA, FX.inboxB)] }),
  },

  // ---- catalog (shopper) ----
  "GET /v1/products/:productId": {
    authz: "self", okStatus: 200,
    okKeys: ["id", "title", "store", "image_url", "blurhash", "price", "condition", "department", "sponsored", "description", "images", "skus", "material", "defect_photos", "return_eligibility", "seller_legal_identity_visible", "seller_legal_identity", "size_chart_available", "updated_at"],
    send: (c, t) => c.h.http().get(`/v1/products/${FX.product}`).set(tok(t)),
  },

  // ---- Seller Center ----
  "GET /v1/seller/categories": {
    authz: "self", aud: "seller_api", okStatus: 200, okKeys: ["items"],
    send: (c, t) => c.h.http().get("/v1/seller/categories").set(tok(t)),
  },
  "GET /v1/seller/products": {
    authz: "self", aud: "seller_api", okStatus: 200, okKeys: ["items", "page"],
    send: (c, t) => c.h.http().get("/v1/seller/products").set(tok(t)),
  },
  "POST /v1/seller/products": {
    authz: "self", aud: "seller_api", okStatus: 201, okKeys: PRODUCT_KEYS,
    send: (c, t) => c.h.http().post("/v1/seller/products").set(tok(t)).set(idem()).send(sellerBody()),
  },
  "GET /v1/seller/products/:productId": {
    authz: "resource", aud: "seller_api", objectId: true, okStatus: 200, okKeys: PRODUCT_KEYS,
    send: (c, t, target = "own") =>
      c.h.http().get(`/v1/seller/products/${pickId(target, FX.product, FX.productForeign)}`).set(tok(t)),
  },
  "PATCH /v1/seller/products/:productId": {
    authz: "resource", aud: "seller_api", objectId: true, okStatus: 200, okKeys: PRODUCT_KEYS,
    send: (c, t, target = "own") =>
      c.h.http().patch(`/v1/seller/products/${pickId(target, FX.product, FX.productForeign)}`).set(tok(t)).set("If-Match", '"x"').send({ material: "cotton" }),
    prepare: async (c, t) => {
      const etag = await etagOf(c, `/v1/seller/products/${FX.product}`, t);
      return () => c.h.http().patch(`/v1/seller/products/${FX.product}`).set(tok(t)).set("If-Match", etag).send({ material: "cotton" });
    },
  },
  "POST /v1/seller/catalog/imports": {
    authz: "self", aud: "seller_api", okStatus: 202, okKeys: IMPORT_KEYS,
    send: (c, t) => c.h.http().post("/v1/seller/catalog/imports").set(tok(t)).set(idem()).send({ upload_id: UP_CSV, dry_run: true }),
  },
  "GET /v1/seller/catalog/imports/:importId": {
    authz: "resource", aud: "seller_api", objectId: true, okStatus: 200, okKeys: IMPORT_KEYS,
    send: (c, t, target = "own") =>
      c.h.http().get(`/v1/seller/catalog/imports/${pickId(target, FX.imp, FX.impForeign)}`).set(tok(t)),
  },
  "PUT /v1/seller/skus/:skuId/stock": {
    authz: "resource", aud: "seller_api", objectId: true, okStatus: 200, okKeys: ["sku_id", "on_hand", "reserved", "available", "updated_at"],
    send: (c, t, target = "own") =>
      c.h.http().put(`/v1/seller/skus/${pickId(target, FX.sku, FX.skuForeign)}/stock`).set(tok(t)).set(idem()).send({ mode: "set", quantity: 10, reason: "recount" }),
  },
  "GET /v1/seller/size-charts": {
    authz: "resource", aud: "seller_api", okStatus: 200, okKeys: ["items", "page"],
    send: (c, t) => c.h.http().get("/v1/seller/size-charts").set(tok(t)),
  },
  "POST /v1/seller/size-charts": {
    authz: "resource", aud: "seller_api", okStatus: 201,
    okKeys: ["id", "product_type", "unit", "rows", "validated", "updated_at", "created_at", "version", "store_id", "issues"],
    send: (c, t) => c.h.http().post("/v1/seller/size-charts").set(tok(t)).send({ product_type: "tops", unit: "cm", rows: TOPS_ROWS }),
  },
  "GET /v1/seller/size-demand": {
    authz: "resource", aud: "seller_api", okStatus: 200, okKeys: ["items", "min_cell_size"],
    send: (c, t) => c.h.http().get("/v1/seller/size-demand").set(tok(t)),
  },
};
Object.assign(MATRIX, MODULE_ENTRIES);

function addCartSku(c: Ctx, skuId: string): void {
  const catalog = c.h.app.get<FakeCatalog>(CART_CATALOG, { strict: false });
  catalog.addSku({ skuId, productId: uid(++seq), storeId: FX.cartStore, title: { ar: "قميص" }, unitPrice: EGP(10_000n), available: true });
}

/** Session id to address: the caller's own, a different user's, or one that does not exist. */
function pick(c: Ctx, target: "own" | "foreign" | "missing"): string {
  return target === "own" ? c.a.sessionId : target === "foreign" ? c.b.sessionId : MISSING_ID;
}

// ---- Route discovery -----------------------------------------------------------------------

interface Discovered {
  readonly key: string;
  readonly meta: AuthzMeta | undefined;
}

const VERB: Record<number, string> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD",
  [RequestMethod.ALL]: "ALL",
};

const asPaths = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : [""]);
const joinPath = (...parts: string[]): string => "/" + parts.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");

function discoverRoutes(h: Harness): Discovered[] {
  const out: Discovered[] = [];
  const discovery = new DiscoveryService(h.app.get(ModulesContainer));
  for (const wrapper of discovery.getControllers()) {
    const type = wrapper.metatype;
    if (type === null || typeof type !== "function") continue;
    const proto = type.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      const fn = proto[name];
      if (typeof fn !== "function") continue;
      const method: unknown = Reflect.getMetadata(METHOD_METADATA, fn);
      if (typeof method !== "number") continue;
      const meta = (Reflect.getMetadata(AUTHZ_META, fn) ?? Reflect.getMetadata(AUTHZ_META, type)) as AuthzMeta | undefined;
      for (const cp of asPaths(Reflect.getMetadata(PATH_METADATA, type))) {
        for (const mp of asPaths(Reflect.getMetadata(PATH_METADATA, fn))) {
          out.push({ key: `${VERB[method] ?? String(method)} ${joinPath("v1", cp, mp)}`, meta });
        }
      }
    }
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

// ---- OpenAPI -------------------------------------------------------------------------------

function openApiOperations(): string[] {
  const text = readFileSync(resolve(REPO, "docs/api/openapi.yaml"), "utf8");
  const ops: string[] = [];
  let path = "";
  let inPaths = false;
  for (const line of text.split("\n")) {
    if (/^paths:\s*$/.test(line)) inPaths = true;
    else if (/^\S/.test(line)) inPaths = false;
    if (!inPaths) continue;
    const p = /^ {2}(\/\S*):\s*$/.exec(line);
    if (p?.[1] !== undefined) path = p[1];
    const m = /^ {4}(get|post|put|patch|delete):\s*$/.exec(line);
    if (m?.[1] !== undefined) ops.push(`${m[1].toUpperCase()} ${path.replace(/\{(\w+)\}/g, ":p")}`);
  }
  return ops;
}

async function prepareFixtures(c: Ctx): Promise<void> {
  const { h } = c;
  const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
  const staff = (storeId: string, n: number) => ({
    id: uid(0x7000 + n),
    status: "active" as const,
    assurance: "passkey" as const,
    grants: [{ kind: "brand" as const, storeId, role: "owner" as const }],
    tokenScopes: ["seller:read", "seller:write"],
  });
  const staffByToken = new Map([
    [SELLER_TOKEN, staff(SELLER_STORE_1, 1)],
    [SELLER_TOKEN_2, staff(SELLER_STORE_2, 2)],
  ]);
  const real = authn.authenticate.bind(authn);
  authn.authenticate = async (token, nowMs) => {
    const actor = staffByToken.get(token);
    if (actor === undefined) return real(token, nowMs);
    const iat = Math.floor(nowMs / 1000);
    return {
      actor,
      claims: { iss: "test", sub: actor.id, aud: "seller_api", iat, exp: iat + 600, jti: `jti-${token}`, sid: `sid-${token}`, amr: ["otp_sms"] },
    };
  };
  const ok = (r: { status: number; body: unknown }, want: number, what: string): void => {
    if (r.status !== want) throw new Error(`fixture ${what}: ${r.status} ${JSON.stringify(r.body)}`);
  };

  // stores
  const list = await h.http().get("/v1/stores?world=everything").set(bearer(c.a.token));
  ok(list, 200, "stores");
  FX.stores = (list.body.items as { id: string }[]).map((s) => s.id);
  FX.favStore = FX.stores[0] ?? "";
  FX.foreignFavStore = FX.stores[1] ?? "";
  const putFav = async (token: string, id: string): Promise<void> => {
    const r = await h.http().put("/v1/me/favorite-stores").set(bearer(token)).set("If-Match", "*").send({ store_ids: [id] });
    ok(r, 200, "favorites");
  };
  await putFav(c.a.token, FX.favStore);
  await putFav(c.b.token, FX.foreignFavStore);

  // wishlists
  const wl = h.app.get<InMemoryCatalogRead>(WISHLIST_CATALOG, { strict: false });
  const summary = (id: string, title: string) => ({
    id,
    title: { ar: title },
    store: { id: uid(0xc1), name: { ar: "متجر" } },
    price: { current: { amount: "129900", currency: "EGP" } },
    condition: "new_with_tags",
    sponsored: false,
  });
  wl.seed({ id: P_DRESS, listed: true, currentPrice: EGP(129_900n), skuIds: [], summary: summary(P_DRESS, "فستان") });
  wl.seed({ id: P_SHOES, listed: true, currentPrice: EGP(89_900n), skuIds: [], summary: summary(P_SHOES, "حذاء") });
  const mkList = async (token: string): Promise<string> => {
    const r = await h.http().post("/v1/me/wishlists").set(bearer(token)).send({ intent: "need", title: "قائمتي" });
    ok(r, 201, "wishlist");
    return String(r.body.id);
  };
  FX.wlA = await mkList(c.a.token);
  FX.wlB = await mkList(c.b.token);
  const item = await h.http().post(`/v1/wishlists/${FX.wlA}/items`).set(bearer(c.a.token)).send({ product_id: P_DRESS });
  ok(item, 201, "wishlist item");
  FX.itemA = String(item.body.id);

  // cart
  const cartCatalog = h.app.get<FakeCatalog>(CART_CATALOG, { strict: false });
  cartCatalog.addStore(FX.cartStore);
  const addLine = async (token: string): Promise<string> => {
    const sku = uid(++seq);
    addCartSku(c, sku);
    const r = await h.http().post("/v1/cart/lines").set(bearer(token)).set(idem()).send({ sku_id: sku, qty: 1 });
    ok(r, 201, "cart line");
    return (r.body.groups as { lines: { id: string }[] }[]).flatMap((g) => g.lines).at(-1)?.id ?? "";
  };
  FX.lineA = await addLine(c.a.token);
  FX.lineB = await addLine(c.b.token);
  addCartSku(c, FX.sku);

  // sizing
  const mkProfile = async (token: string): Promise<string> => {
    const r = await h.http().post("/v1/me/size-profiles").set(bearer(token)).send(sizeProfileBody);
    ok(r, 201, "size profile");
    return String(r.body.id);
  };
  FX.profA = await mkProfile(c.a.token);
  FX.profB = await mkProfile(c.b.token);
  h.app.get<InMemoryFitCatalog>(FIT_CATALOG, { strict: false }).seed({
    productId: FX.fitProduct,
    storeId: SELLER_STORE_1,
    brandId: SEED.brandAcme,
    productType: "tops",
    stretch: "none",
  });
  const lines = h.app.get<InMemoryOrderLines>(ORDER_LINE_FIT, { strict: false });
  for (const [user, line] of [[c.a.userId, FX.lineFeedbackA], [c.b.userId, FX.lineFeedbackB]] as const) {
    lines.seed(user, line, {
      kind: "delivered",
      line: { orderLineId: line, productId: FX.fitProduct, brandId: SEED.brandAcme, productType: "tops", sizeLabel: "M", sizeChartId: null },
    });
  }

  // notifications inbox
  const contacts = h.app.get<InMemoryContactPort>(NOTIFICATION_CONTACTS, { strict: false });
  const sender = h.app.get<SendNotification>(SEND_NOTIFICATION, { strict: false });
  const mkInbox = async (user: Session, phone: string): Promise<string> => {
    contacts.set(user.userId, { locale: "ar", phone, email: null });
    const sent = await sender.execute({ userId: user.userId, templateKey: "refund_completed", ref: `matrix-${user.userId}`, payload: {} });
    if (sent.kind !== "accepted") throw new Error(`fixture inbox: ${JSON.stringify(sent)}`);
    const r = await h.http().get("/v1/me/notifications").set(bearer(user.token));
    ok(r, 200, "inbox");
    return String((r.body.items as { id: string }[])[0]?.id);
  };
  FX.inboxA = await mkInbox(c.a, "+201007770001");
  FX.inboxB = await mkInbox(c.b, "+201007770002");

  // catalog + seller center
  const fx = h.app.get<CatalogDevFixtures>(CATALOG_DEV_FIXTURES, { strict: false });
  for (const [id, slug, nameAr] of [[SELLER_STORE_1, "matrix-1", "متجر ١"], [SELLER_STORE_2, "matrix-2", "متجر ٢"]] as const) {
    fx.stores.set({
      id, slug, nameAr, kind: "local", verifiedBadge: false, liveDrop: false, isFavorite: false, visible: true,
      legal: { legalName: `Legal ${slug}`, commercialRegisterNo: "CR-1", taxCardNo: "TC-1", governorate: "Cairo", approved: true },
    });
  }
  fx.uploads.add(SELLER_STORE_1, UP_IMG);
  fx.uploads.add(SELLER_STORE_2, UP_IMG_2);
  const chart = await h.http().post("/v1/seller/size-charts").set(bearer(SELLER_TOKEN)).send({ product_type: "tops", unit: "cm", rows: TOPS_ROWS });
  ok(chart, 201, "size chart");
  const csv = [CSV_HEADER, `p1,فستان p1,,وصف,dresses,acme,new_with_tags,M,White,p1-M,,1299.50,5,${UP_IMG},`].join("\n");
  fx.uploads.add(SELLER_STORE_1, UP_CSV, csv);
  const mkProduct = async (token: string, upload: string): Promise<string> => {
    const r = await h.http().post("/v1/seller/products").set(bearer(token)).set(idem()).send(sellerBody({ image_upload_ids: [upload] }));
    ok(r, 201, "product");
    return String(r.body.id);
  };
  FX.product = await mkProduct(SELLER_TOKEN, UP_IMG);
  FX.productForeign = await mkProduct(SELLER_TOKEN_2, UP_IMG_2);
  const etag = await etagOf(c, `/v1/seller/products/${FX.product}`, SELLER_TOKEN);
  ok(await h.http().patch(`/v1/seller/products/${FX.product}`).set(bearer(SELLER_TOKEN)).set("If-Match", etag).send({ status: "active" }), 200, "activate");
  const mkImport = async (token: string, store: string): Promise<string> => {
    const up = uid(++seq);
    fx.uploads.add(store, up, csv);
    const r = await h.http().post("/v1/seller/catalog/imports").set(bearer(token)).set(idem()).send({ upload_id: up, dry_run: true });
    ok(r, 202, "import");
    return String(r.body.id);
  };
  FX.imp = await mkImport(SELLER_TOKEN, SELLER_STORE_1);
  FX.impForeign = await mkImport(SELLER_TOKEN_2, SELLER_STORE_2);

  // inventory
  const dir = h.app.get<InMemorySkuDirectory>(INVENTORY_SKU_DIRECTORY, { strict: false });
  dir.register(FX.sku, { storeId: SELLER_STORE_1, locationId: uid(0x8101), dropId: null });
  dir.register(FX.skuForeign, { storeId: SELLER_STORE_2, locationId: uid(0x8102), dropId: null });
}


// ---- Wave 3 routes: negative authorization is proven by the owning module's suite ------------
// These routes need module fixtures (orders, returns, shipments, promotions) that the shared
// harness does not seed. The central check below still enforces, for each: a declared authz mode
// matching this table, an openapi + authz-matrix.md entry, a 401 without credentials, and that the
// named per-module suite exists and mentions the route family (so a deleted suite fails here).
interface Delegated {
  readonly authz: "public" | "self" | "resource";
  readonly suite: string;
}
const DELEGATED: Record<string, Delegated> = {
  "DELETE /v1/admin/promotions/:promotionId": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "DELETE /v1/me/privacy/delete": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "DELETE /v1/me/saved-searches/:savedSearchId": { authz: "self", suite: "src/modules/search/test/search.authz.test.ts" },
  "DELETE /v1/seller/promotions/:promotionId": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "GET /v1/admin/privacy/breaches": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "GET /v1/admin/privacy/requests": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "GET /v1/admin/promotions": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "GET /v1/admin/promotions/:promotionId": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "GET /v1/me/privacy/delete": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "GET /v1/me/privacy/export/latest": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "GET /v1/me/privacy/export/:exportId": { authz: "resource", suite: "src/modules/privacy/privacy.http.test.ts" },
  "GET /v1/me/returns": { authz: "self", suite: "src/modules/returns/test/returns.authz.test.ts" },
  "GET /v1/me/returns/:returnId": { authz: "resource", suite: "src/modules/returns/test/returns.authz.test.ts" },
  "GET /v1/me/saved-searches": { authz: "self", suite: "src/modules/search/test/search.authz.test.ts" },
  "GET /v1/me/saved-searches/:savedSearchId": { authz: "self", suite: "src/modules/search/test/search.authz.test.ts" },
  "GET /v1/me/orders": { authz: "self", suite: "src/modules/orders/test/orders.http.test.ts" },
  "GET /v1/order-groups/:id": { authz: "resource", suite: "src/modules/orders/test/orders.http.test.ts" },
  "GET /v1/search": { authz: "self", suite: "src/modules/search/test/search.authz.test.ts" },
  "GET /v1/search/suggestions": { authz: "self", suite: "src/modules/search/test/search.authz.test.ts" },
  "GET /v1/seller/orders": { authz: "self", suite: "src/modules/orders/test/orders.http.test.ts" },
  "DELETE /v1/seller/applications/:id/documents/:documentId": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "GET /v1/seller/applications": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "GET /v1/seller/applications/:id": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "GET /v1/seller/applications/requirements": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "GET /v1/seller/onboarding-checklist": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "PATCH /v1/seller/applications/:id": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "POST /v1/seller/applications": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "POST /v1/seller/applications/:id/appeal": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "POST /v1/seller/applications/:id/documents": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "POST /v1/seller/applications/:id/documents/:documentId/confirm": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "POST /v1/seller/applications/:id/resubmit": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "POST /v1/seller/applications/:id/submit": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "POST /v1/seller/applications/:id/withdraw": { authz: "self", suite: "src/modules/sellers/test/sellers.http.test.ts" },
  "GET /v1/seller/orders/:id": { authz: "resource", suite: "src/modules/orders/test/orders.http.test.ts" },
  "GET /v1/seller/promotions": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "GET /v1/seller/promotions/:promotionId": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "GET /v1/seller/returns": { authz: "resource", suite: "src/modules/returns/test/returns.authz.test.ts" },
  "GET /v1/seller/shipments/:shipmentId": { authz: "resource", suite: "src/modules/fulfillment/test/fulfillment.authz.test.ts" },
  "GET /v1/seller/shipments/:shipmentId/label": { authz: "resource", suite: "src/modules/fulfillment/test/fulfillment.authz.test.ts" },
  "PATCH /v1/admin/promotions/:promotionId": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "PATCH /v1/me/saved-searches/:savedSearchId": { authz: "self", suite: "src/modules/search/test/search.authz.test.ts" },
  "PATCH /v1/seller/promotions/:promotionId": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "POST /v1/admin/privacy/breaches": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "POST /v1/admin/privacy/breaches/:id/close": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "POST /v1/admin/privacy/breaches/:id/pdpc-notified": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "POST /v1/admin/privacy/breaches/:id/subjects-notified": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "POST /v1/admin/privacy/breaches/:id/triage": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "POST /v1/admin/promotions": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "POST /v1/me/privacy/delete": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "POST /v1/me/privacy/export": { authz: "self", suite: "src/modules/privacy/privacy.http.test.ts" },
  "POST /v1/me/saved-searches": { authz: "self", suite: "src/modules/search/test/search.authz.test.ts" },
  "POST /v1/orders/lines/:orderLineId/returns": { authz: "resource", suite: "src/modules/returns/test/returns.authz.test.ts" },
  "POST /v1/promotions/evaluate": { authz: "public", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "POST /v1/returns/:returnId/dispute": { authz: "resource", suite: "src/modules/returns/test/returns.authz.test.ts" },
  "POST /v1/search/parse": { authz: "self", suite: "src/modules/search/test/search.authz.test.ts" },
  "POST /v1/seller-orders/:id/cancel": { authz: "resource", suite: "src/modules/orders/test/orders.http.test.ts" },
  "POST /v1/seller/orders/:id/accept": { authz: "resource", suite: "src/modules/orders/test/orders.http.test.ts" },
  "POST /v1/seller/orders/:id/pack": { authz: "resource", suite: "src/modules/orders/test/orders.http.test.ts" },
  "POST /v1/seller/orders/:id/reject": { authz: "resource", suite: "src/modules/orders/test/orders.http.test.ts" },
  "POST /v1/seller/promotions": { authz: "self", suite: "src/modules/promotions/test/promotions.authz.test.ts" },
  "POST /v1/seller/returns/:returnId/inspect": { authz: "resource", suite: "src/modules/returns/test/returns.authz.test.ts" },
  "POST /v1/seller/shipments": { authz: "self", suite: "src/modules/fulfillment/test/fulfillment.authz.test.ts" },
  "POST /v1/webhooks/couriers/:courier": { authz: "public", suite: "src/modules/fulfillment/test/fulfillment.authz.test.ts" },
  "GET /v1/seller/stores/:storeId/forecasts": { authz: "resource", suite: "src/modules/forecasting/test/forecast.http.test.ts" },
  "GET /v1/seller/stores/:storeId/product-media": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "POST /v1/seller/stores/:storeId/product-media/uploads": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "GET /v1/seller/stores/:storeId/product-media/:jobId": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "POST /v1/seller/stores/:storeId/product-media/:jobId/process": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "POST /v1/seller/stores/:storeId/product-media/:jobId/accept": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "POST /v1/seller/stores/:storeId/product-media/:jobId/use-original": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "POST /v1/seller/stores/:storeId/product-media/:jobId/rerun": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "POST /v1/seller/stores/:storeId/product-media/:jobId/refine": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "GET /v1/seller/stores/:storeId/product-media/:jobId/versions": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "POST /v1/seller/stores/:storeId/product-media/:jobId/versions/:version/restore": { authz: "resource", suite: "src/modules/product-media/test/product-media.http.test.ts" },
  "GET /v1/admin/ranking/shadow/summary": { authz: "resource", suite: "src/modules/ranking/test/ranking.http.test.ts" },
  "GET /v1/admin/ranking/evaluations": { authz: "resource", suite: "src/modules/ranking/test/ranking.http.test.ts" },
  "POST /v1/admin/ranking/evaluations": { authz: "resource", suite: "src/modules/ranking/test/ranking.http.test.ts" },
  "POST /v1/admin/ranking/guardrails/evaluate": { authz: "resource", suite: "src/modules/ranking/test/ranking.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/aging": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/funnel": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/geography": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/returns": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/sales": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/search-terms": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/sell-through": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/size-curve": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/traffic": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/admin/me": { authz: "self", suite: "src/modules/admin/admin-me.http.test.ts" },
  "GET /v1/admin/attention": { authz: "self", suite: "src/modules/admin-attention/test/admin-attention.http.test.ts" },
  "GET /v1/admin/audit-log/verify": { authz: "self", suite: "src/modules/admin-attention/test/admin-attention.http.test.ts" },
  "GET /v1/admin/metrics/:metricId": { authz: "self", suite: "src/modules/platform-metrics/test/metrics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/series/:metricId": { authz: "resource", suite: "src/modules/seller-analytics/test/series.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/series/:metricId/breakdown": { authz: "resource", suite: "src/modules/seller-analytics/test/series.http.test.ts" },
  "GET /v1/seller/stores/:storeId/analytics/summary": { authz: "resource", suite: "src/modules/seller-analytics/test/series.http.test.ts" },
  "DELETE /v1/me/reviews/:reviewId": { authz: "resource", suite: "src/modules/reviews/reviews.http.test.ts" },
  "GET /v1/admin/brand-applications": { authz: "self", suite: "src/modules/admin/brand-review/brand-review.http.test.ts" },
  "GET /v1/admin/brand-applications/:id": { authz: "self", suite: "src/modules/admin/brand-review/brand-review.http.test.ts" },
  "POST /v1/admin/brand-applications/:id/claim": { authz: "self", suite: "src/modules/admin/brand-review/brand-review.http.test.ts" },
  "POST /v1/admin/brand-applications/:id/release": { authz: "self", suite: "src/modules/admin/brand-review/brand-review.http.test.ts" },
  "POST /v1/admin/brand-applications/:id/decision": { authz: "self", suite: "src/modules/admin/brand-review/brand-review.http.test.ts" },
  "POST /v1/admin/brand-applications/:id/cosign": { authz: "self", suite: "src/modules/admin/brand-review/brand-review.http.test.ts" },
  "POST /v1/admin/brand-applications/:id/retry-provisioning": { authz: "self", suite: "src/modules/admin/brand-review/brand-review.http.test.ts" },
  "GET /v1/me/auto-buy/terms": { authz: "self", suite: "src/modules/auto-buy/auto-buy.http.test.ts" },
  "POST /v1/search/visual/uploads": { authz: "self", suite: "src/modules/visual-search/visual-search.http.test.ts" },
  "POST /v1/search/visual": { authz: "self", suite: "src/modules/visual-search/visual-search.http.test.ts" },
  "GET /v1/products/:productId/visually-similar": { authz: "public", suite: "src/modules/visual-search/visual-search.http.test.ts" },
  "POST /v1/admin/brand-applications/:id/documents/:document_id/read-url": { authz: "self", suite: "src/modules/admin/brand-review/brand-review.http.test.ts" },
  "GET /v1/admin/approvals": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/approvals/:id": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/elevations": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/elevations/mine": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/flags": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/flags/:key": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/kill-switches": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/kyc/queue": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/kyc/sellers/:sellerId": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/kyc/suspension-reviews": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "GET /v1/admin/moderation/queue": { authz: "resource", suite: "src/modules/reviews/reviews.http.test.ts" },
  "GET /v1/admin/tax/categories": { authz: "self", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  "GET /v1/admin/tax/documents": { authz: "self", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  "GET /v1/admin/tax/documents/:documentId": { authz: "self", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  "GET /v1/admin/tax/exemption-audit": { authz: "self", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  "GET /v1/admin/tax/reconciliation": { authz: "self", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  "GET /v1/me/referral": { authz: "self", suite: "src/modules/referrals/referrals.http.test.ts" },
  "GET /v1/me/reviews": { authz: "self", suite: "src/modules/reviews/reviews.http.test.ts" },
  "GET /v1/products/:productId/price-evidence": { authz: "self", suite: "src/modules/price-integrity/test/http.authz.test.ts" },
  "GET /v1/products/:productId/questions": { authz: "public", suite: "src/modules/reviews/reviews.http.test.ts" },
  "GET /v1/products/:productId/reviews": { authz: "public", suite: "src/modules/reviews/reviews.http.test.ts" },
  "GET /v1/seller/invoices": { authz: "resource", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  "GET /v1/seller/invoices/:documentId": { authz: "resource", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  "GET /v1/seller/price-trust": { authz: "self", suite: "src/modules/price-integrity/test/http.authz.test.ts" },
  "GET /v1/seller/questions": { authz: "resource", suite: "src/modules/reviews/reviews.http.test.ts" },
  "GET /v1/seller/reviews": { authz: "resource", suite: "src/modules/reviews/reviews.http.test.ts" },
  "PATCH /v1/me/reviews/:reviewId": { authz: "resource", suite: "src/modules/reviews/reviews.http.test.ts" },
  "POST /v1/admin/approvals": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/approvals/:id/approve": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/approvals/:id/reject": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/elevations": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/elevations/:id/activate": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/elevations/:id/revoke": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/kyc/sellers/:sellerId/reinstate": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/kyc/sellers/:sellerId/suspend": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/kyc/suspension-reviews/:id/uphold": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/moderation/:targetType/:targetId/decision": { authz: "resource", suite: "src/modules/reviews/reviews.http.test.ts" },
  "POST /v1/admin/pii-views": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "POST /v1/admin/tax/categories/:code/exemption/clear": { authz: "self", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  "POST /v1/admin/tax/submissions/:documentId/requeue": { authz: "self", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  "POST /v1/orders/lines/:orderLineId/review": { authz: "resource", suite: "src/modules/reviews/reviews.http.test.ts" },
  "POST /v1/products/:productId/questions": { authz: "self", suite: "src/modules/reviews/reviews.http.test.ts" },
  "POST /v1/referrals/attribute": { authz: "self", suite: "src/modules/referrals/referrals.http.test.ts" },
  "POST /v1/seller/questions/:questionId/answer": { authz: "resource", suite: "src/modules/reviews/reviews.http.test.ts" },
  "POST /v1/seller/reviews/:reviewId/reply": { authz: "resource", suite: "src/modules/reviews/reviews.http.test.ts" },
  "POST /v1/seller/stores/:storeId/analytics/exports": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "POST /v1/ugc/reports": { authz: "self", suite: "src/modules/reviews/reviews.http.test.ts" },
  "PUT /v1/admin/flags/:key": { authz: "self", suite: "src/modules/admin/admin.http.test.ts" },
  "PUT /v1/admin/tax/categories/:code/exemption": { authz: "self", suite: "src/modules/tax-eta/test/tax-eta.http.test.ts" },
  // Wave 4 money core (owning module suites carry the negative authorization tests).
  "GET /v1/admin/ledger/balances": { authz: "self", suite: "src/modules/ledger/test/ledger.http.test.ts" },
  "GET /v1/admin/ledger/entries/:id": { authz: "self", suite: "src/modules/ledger/test/ledger.http.test.ts" },
  "GET /v1/admin/ledger/integrity": { authz: "self", suite: "src/modules/ledger/test/integrity.http.test.ts" },
  "GET /v1/admin/ledger/integrity/runs": { authz: "self", suite: "src/modules/ledger/test/integrity.http.test.ts" },
  "POST /v1/analytics/events": { authz: "self", suite: "src/modules/analytics-ingest/test/ingest.http.test.ts" },
  "POST /v1/webhooks/:provider": { authz: "public", suite: "src/modules/payments/test/http.test.ts" },
  "GET /v1/payments/methods": { authz: "self", suite: "src/modules/payments/test/http.test.ts" },
  "GET /v1/me/payment-methods": { authz: "self", suite: "src/modules/payments/test/http.test.ts" },
  "DELETE /v1/me/payment-methods/:id": { authz: "self", suite: "src/modules/payments/test/http.test.ts" },
  "POST /v1/checkout/quote": { authz: "self", suite: "src/modules/checkout/test/checkout.http.test.ts" },
  "POST /v1/checkout": { authz: "self", suite: "src/modules/checkout/test/checkout.http.test.ts" },
  "GET /v1/checkout/:id": { authz: "resource", suite: "src/modules/checkout/test/checkout.http.test.ts" },
  "POST /v1/checkout/:id/cancel": { authz: "resource", suite: "src/modules/checkout/test/checkout.http.test.ts" },
  "POST /v1/checkout/:id/confirm-cod": { authz: "resource", suite: "src/modules/checkout/test/checkout.http.test.ts" },
  "POST /v1/webhooks/checkout/:provider": { authz: "public", suite: "src/modules/checkout/test/checkout.http.test.ts" },
  "GET /v1/me/refunds": { authz: "self", suite: "src/modules/refunds/test/http.test.ts" },
  "GET /v1/refunds/:id": { authz: "self", suite: "src/modules/refunds/test/http.test.ts" },
  "GET /v1/me/addresses": { authz: "self", suite: "src/modules/addresses/addresses.http.test.ts" },
  "POST /v1/me/addresses": { authz: "self", suite: "src/modules/addresses/addresses.http.test.ts" },
  "GET /v1/me/addresses/:addressId": { authz: "self", suite: "src/modules/addresses/addresses.http.test.ts" },
  "PATCH /v1/me/addresses/:addressId": { authz: "self", suite: "src/modules/addresses/addresses.http.test.ts" },
  "DELETE /v1/me/addresses/:addressId": { authz: "self", suite: "src/modules/addresses/addresses.http.test.ts" },
  "POST /v1/me/addresses/:addressId/default": { authz: "self", suite: "src/modules/addresses/addresses.http.test.ts" },
  "GET /v1/coverage/governorates": { authz: "self", suite: "src/modules/addresses/addresses.http.test.ts" },
  "GET /v1/coverage/cities": { authz: "self", suite: "src/modules/addresses/addresses.http.test.ts" },
  "GET /v1/me/wallet": { authz: "self", suite: "src/modules/refunds/test/http.test.ts" },
  "GET /v1/me/wallet/transactions": { authz: "self", suite: "src/modules/refunds/test/http.test.ts" },
  // Seller settings (owning suite carries the per-route negative authorization tests).
  "GET /v1/seller/stores/:id/profile": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "PUT /v1/seller/stores/:id/profile": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "PUT /v1/seller/stores/:id/vacation": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "GET /v1/seller/stores/:id/storefront-preview": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "POST /v1/seller/stores/:id/media/uploads": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "POST /v1/seller/stores/:id/media/uploads/:uploadId/confirm": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "POST /v1/seller/stores/:id/media/product-uploads": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "GET /v1/seller/stores/:id/payout-account": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "PUT /v1/seller/stores/:id/payout-account": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "GET /v1/seller/stores/:id/payout-account/history": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "GET /v1/seller/stores/:id/shipping": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "PUT /v1/seller/stores/:id/shipping": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "GET /v1/seller/stores/:id/notification-preferences": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "PUT /v1/seller/stores/:id/notification-preferences": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "GET /v1/seller/stores/:id/team": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "POST /v1/seller/stores/:id/team/invites": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "DELETE /v1/seller/stores/:id/team/invites/:inviteId": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "PATCH /v1/seller/stores/:id/team/members/:userId": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "DELETE /v1/seller/stores/:id/team/members/:userId": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "POST /v1/seller/team-invites/accept": { authz: "self", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "POST /v1/seller/team-invites/decline": { authz: "self", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "GET /v1/seller/stores/:id/eta-enrolment": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "POST /v1/seller/stores/:id/eta-enrolment/request": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "POST /v1/seller/stores/:id/eta-enrolment/revoke": { authz: "resource", suite: "src/modules/seller-settings/test/seller-settings.http.test.ts" },
  "GET /v1/seller/payouts": { authz: "self", suite: "src/modules/payouts/test/payouts.http.test.ts" },
  "GET /v1/seller/payouts/:id": { authz: "resource", suite: "src/modules/payouts/test/payouts.http.test.ts" },
  "GET /v1/seller/stores/:id/statements": { authz: "resource", suite: "src/modules/payouts/test/payouts.http.test.ts" },
  "GET /v1/seller/stores/:storeId/balance": { authz: "resource", suite: "src/modules/payouts/test/balance.http.test.ts" },
  "GET /v1/admin/finance/payouts": { authz: "self", suite: "src/modules/payouts/test/payouts.http.test.ts" },
  "GET /v1/admin/finance/payouts/summary": { authz: "self", suite: "src/modules/payouts/test/payouts-summary.http.test.ts" },
  "GET /v1/admin/finance/payouts/:id": { authz: "resource", suite: "src/modules/payouts/test/payouts.http.test.ts" },
  "POST /v1/admin/finance/payouts/:id/approve": { authz: "resource", suite: "src/modules/payouts/test/payouts.http.test.ts" },
  "POST /v1/admin/finance/payouts/:id/hold": { authz: "resource", suite: "src/modules/payouts/test/payouts.http.test.ts" },
  "POST /v1/admin/finance/payouts/:id/cancel": { authz: "resource", suite: "src/modules/payouts/test/payouts.http.test.ts" },
  "GET /v1/admin/finance/reconciliation/summary": { authz: "self", suite: "src/modules/reconciliation/test/recon.http.test.ts" },
  "GET /v1/admin/finance/reconciliation/tickets": { authz: "self", suite: "src/modules/reconciliation/test/recon.http.test.ts" },
  "GET /v1/admin/finance/reconciliation/tickets/:id": { authz: "self", suite: "src/modules/reconciliation/test/recon.http.test.ts" },
  "GET /v1/admin/finance/reconciliation/runs": { authz: "self", suite: "src/modules/reconciliation/test/recon.http.test.ts" },
  "GET /v1/admin/finance/reconciliation/files": { authz: "self", suite: "src/modules/reconciliation/test/recon.http.test.ts" },
  // Phase 2 (subscriptions, gift cards, budget, stylist, recommendations, history, rewards, drops, waiting room,
  // price crawler, hub consolidation, resale lane, ads). Owning module suites carry the negative authorization tests.
  "GET /v1/admin/resale/listings": { authz: "resource", suite: "src/modules/resale-lane/resale.http.test.ts" },
  "GET /v1/admin/hub/consolidations": { authz: "resource", suite: "src/modules/hub-consolidation/hub.http.test.ts" },
  "GET /v1/seller/hub/consolidations": { authz: "resource", suite: "src/modules/hub-consolidation/hub.http.test.ts" },
  "GET /v1/seller/stylist/inclusion": { authz: "resource", suite: "src/modules/stylist/stylist.http.test.ts" },
  "GET /v1/seller/me": { authz: "resource", suite: "src/modules/seller-analytics/test/analytics.http.test.ts" },
  "GET /v1/seller/stores/:storeId/me": { authz: "resource", suite: "src/modules/seller-analytics/test/seller-me.http.test.ts" },
  "GET /v1/admin/ads/config": { authz: "resource", suite: "src/modules/ads/ads.http.test.ts" },
  "GET /v1/seller/ads/balance": { authz: "self", suite: "src/modules/ads/ads.http.test.ts" },
  "GET /v1/seller/ads/campaigns": { authz: "self", suite: "src/modules/ads/ads.http.test.ts" },
  "GET /v1/seller/ads/campaigns/:id": { authz: "resource", suite: "src/modules/ads/ads.http.test.ts" },
  "GET /v1/seller/ads/reports": { authz: "self", suite: "src/modules/ads/ads.http.test.ts" },
  "PATCH /v1/seller/ads/campaigns/:id": { authz: "resource", suite: "src/modules/ads/ads.http.test.ts" },
  "POST /v1/ads/click": { authz: "self", suite: "src/modules/ads/ads.http.test.ts" },
  "POST /v1/seller/ads/campaigns": { authz: "self", suite: "src/modules/ads/ads.http.test.ts" },
  "POST /v1/seller/ads/campaigns/:id/pause": { authz: "resource", suite: "src/modules/ads/ads.http.test.ts" },
  "POST /v1/seller/ads/campaigns/:id/resume": { authz: "resource", suite: "src/modules/ads/ads.http.test.ts" },
  "POST /v1/seller/ads/topup": { authz: "self", suite: "src/modules/ads/ads.http.test.ts" },
  "PUT /v1/admin/ads/config": { authz: "resource", suite: "src/modules/ads/ads.http.test.ts" },
  "GET /v1/admin/ads/invalid-clicks": { authz: "resource", suite: "src/modules/ads/click-review.http.test.ts" },
  "POST /v1/admin/ads/invalid-clicks/:id/decision": { authz: "resource", suite: "src/modules/ads/click-review.http.test.ts" },
  // Brand verification (ADR-0031). Ownership is checked in the controller through ApplicationOwnershipPort (unknown and foreign are both 404).
  "POST /v1/seller/applications/:id/domain-verification": { authz: "self", suite: "src/modules/brand-verification/brand-verification.http.test.ts" },
  "POST /v1/seller/applications/:id/domain-verification/confirm": { authz: "self", suite: "src/modules/brand-verification/brand-verification.http.test.ts" },
  "POST /v1/admin/brand-applications/:id/trademark-lookup": { authz: "resource", suite: "src/modules/brand-verification/brand-verification.http.test.ts" },
  "POST /v1/admin/brand-applications/:id/conflict-resolution": { authz: "resource", suite: "src/modules/brand-verification/brand-verification.http.test.ts" },
  "GET /v1/admin/price-crawler/incidents": { authz: "resource", suite: "src/modules/price-crawler/incidents.http.test.ts" },
  "GET /v1/seller/crawl-incidents": { authz: "self", suite: "src/modules/price-crawler/incidents.http.test.ts" },
  "GET /v1/seller/parity-warnings": { authz: "self", suite: "src/modules/price-crawler/incidents.http.test.ts" },
  "DELETE /v1/me/budget": { authz: "self", suite: "src/modules/budget/budget.http.test.ts" },
  "GET /v1/me/affordability": { authz: "self", suite: "src/modules/budget/budget.http.test.ts" },
  "GET /v1/me/budget/summary": { authz: "self", suite: "src/modules/budget/budget.http.test.ts" },
  "POST /v1/me/budget/cap-unlock": { authz: "self", suite: "src/modules/budget/budget.http.test.ts" },
  "POST /v1/me/budget/plan": { authz: "self", suite: "src/modules/budget/budget.http.test.ts" },
  "PUT /v1/me/budget": { authz: "self", suite: "src/modules/budget/budget.http.test.ts" },
  "POST /v1/me/auto-buy": { authz: "self", suite: "src/modules/auto-buy/auto-buy.http.test.ts" },
  "GET /v1/me/auto-buy": { authz: "self", suite: "src/modules/auto-buy/auto-buy.http.test.ts" },
  "DELETE /v1/me/auto-buy/:id": { authz: "self", suite: "src/modules/auto-buy/auto-buy.http.test.ts" },
  "POST /v1/me/auto-buy/attempts/:id/cancel": { authz: "self", suite: "src/modules/auto-buy/auto-buy.http.test.ts" },
  "POST /v1/me/auto-buy/attempts/:id/sca-complete": { authz: "self", suite: "src/modules/auto-buy/auto-buy-sca-ops.http.test.ts" },
  "GET /v1/admin/auto-buy/manual-review": { authz: "self", suite: "src/modules/auto-buy/auto-buy-sca-ops.http.test.ts" },
  "POST /v1/admin/auto-buy/manual-review/:id/resolve": { authz: "self", suite: "src/modules/auto-buy/auto-buy-sca-ops.http.test.ts" },
  "GET /v1/admin/price-matching/config": { authz: "resource", suite: "src/modules/price-crawler/crawler.http.test.ts" },
  "GET /v1/seller/stores/:storeId/channels": { authz: "resource", suite: "src/modules/price-crawler/crawler.http.test.ts" },
  "GET /v1/seller/stores/:storeId/crawl-targets": { authz: "resource", suite: "src/modules/price-crawler/crawler.http.test.ts" },
  "GET /v1/seller/stores/:storeId/price-matches": { authz: "resource", suite: "src/modules/price-crawler/crawler.http.test.ts" },
  "GET /v1/seller/stores/:storeId/odoo-channels": { authz: "resource", suite: "src/modules/channel-odoo/odoo.http.test.ts" },
  "POST /v1/seller/stores/:storeId/odoo-channels": { authz: "resource", suite: "src/modules/channel-odoo/odoo.http.test.ts" },
  "POST /v1/seller/stores/:storeId/odoo-channels/:channelId/test": { authz: "resource", suite: "src/modules/channel-odoo/odoo.http.test.ts" },
  "DELETE /v1/seller/stores/:storeId/odoo-channels/:channelId": { authz: "resource", suite: "src/modules/channel-odoo/odoo.http.test.ts" },
  "POST /v1/seller/stores/:storeId/channels": { authz: "resource", suite: "src/modules/price-crawler/crawler.http.test.ts" },
  "POST /v1/seller/stores/:storeId/crawl-targets": { authz: "resource", suite: "src/modules/price-crawler/crawler.http.test.ts" },
  "POST /v1/seller/stores/:storeId/crawl-targets/:targetId/verify": { authz: "resource", suite: "src/modules/price-crawler/crawler.http.test.ts" },
  "DELETE /v1/seller/drops/:id": { authz: "resource", suite: "src/modules/drops/drops.http.test.ts" },
  "GET /v1/drops": { authz: "public", suite: "src/modules/drops/drops.http.test.ts" },
  "GET /v1/drops/:id": { authz: "public", suite: "src/modules/drops/drops.http.test.ts" },
  // Anonymous catalog reads for the shopper web (spec P3-06). Each owning suite asserts the allow-listed keys,
  // 404 for every non-public state, bounded queries, CDN headers, the kill switch and that no cookie is set.
  "GET /v1/public/stores": { authz: "public", suite: "src/modules/stores/stores.public.http.test.ts" },
  "GET /v1/public/stores/:storeId": { authz: "public", suite: "src/modules/stores/stores.public.http.test.ts" },
  "GET /v1/public/sitemap/stores/:page": { authz: "public", suite: "src/modules/stores/stores.public.http.test.ts" },
  "GET /v1/public/products/:productId": { authz: "public", suite: "src/modules/catalog/test/catalog.public.http.test.ts" },
  "GET /v1/public/categories": { authz: "public", suite: "src/modules/catalog/test/catalog.public.http.test.ts" },
  "GET /v1/public/sitemap/products/:page": { authz: "public", suite: "src/modules/catalog/test/catalog.public.http.test.ts" },
  "GET /v1/public/search": { authz: "public", suite: "src/modules/search/test/search.public.http.test.ts" },
  // Guest browsing (ADR-0055), all behind flag.guest_browsing (404 while blocked). The merge is the ONLY write.
  "POST /v1/me/guest-merge": { authz: "self", suite: "src/modules/guest-merge/test/guest-merge.authz.test.ts" },
  "GET /v1/public/skus": { authz: "public", suite: "src/modules/guest-merge/test/guest-public.http.test.ts" },
  "GET /v1/public/feed": { authz: "public", suite: "src/modules/guest-merge/test/guest-public.http.test.ts" },
  "GET /v1/public/home/banners": { authz: "public", suite: "src/modules/guest-merge/test/guest-public.http.test.ts" },
  "GET /v1/public/search/suggestions": { authz: "public", suite: "src/modules/guest-merge/test/guest-public.http.test.ts" },
  "GET /v1/seller/drops": { authz: "resource", suite: "src/modules/drops/drops.http.test.ts" },
  "GET /v1/seller/drops/:id": { authz: "resource", suite: "src/modules/drops/drops.http.test.ts" },
  "PATCH /v1/seller/drops/:id": { authz: "resource", suite: "src/modules/drops/drops.http.test.ts" },
  "POST /v1/admin/drops/:id/pause": { authz: "resource", suite: "src/modules/drops/drops.http.test.ts" },
  "GET /v1/admin/drops/ops": { authz: "resource", suite: "src/modules/drops/drops.http.test.ts" },
  "POST /v1/drops/:id/waitlist": { authz: "self", suite: "src/modules/drops/drops.http.test.ts" },
  "POST /v1/seller/drops": { authz: "resource", suite: "src/modules/drops/drops.http.test.ts" },
  "POST /v1/seller/drops/:id/schedule": { authz: "resource", suite: "src/modules/drops/drops.http.test.ts" },
  "GET /v1/gift-pots/:id": { authz: "resource", suite: "src/modules/gift-cards/gift-cards.http.test.ts" },
  "GET /v1/me/gift-cards": { authz: "self", suite: "src/modules/gift-cards/gift-cards.http.test.ts" },
  "GET /v1/shared/gift-pots/:token": { authz: "public", suite: "src/modules/gift-cards/gift-cards.http.test.ts" },
  "POST /v1/gift-cards": { authz: "self", suite: "src/modules/gift-cards/gift-cards.http.test.ts" },
  "POST /v1/gift-cards/:id/void": { authz: "resource", suite: "src/modules/gift-cards/gift-cards.http.test.ts" },
  "POST /v1/gift-cards/redeem": { authz: "self", suite: "src/modules/gift-cards/gift-cards.http.test.ts" },
  "POST /v1/gift-pots": { authz: "self", suite: "src/modules/gift-cards/gift-cards.http.test.ts" },
  "POST /v1/gift-pots/:id/contribute": { authz: "self", suite: "src/modules/gift-cards/gift-cards.http.test.ts" },
  "DELETE /v1/me/history": { authz: "self", suite: "src/modules/recommendations/history-flows.http.test.ts" },
  "GET /v1/me/history": { authz: "self", suite: "src/modules/recommendations/history-flows.http.test.ts" },
  "GET /v1/me/recently-viewed": { authz: "self", suite: "src/modules/recommendations/history-flows.http.test.ts" },
  "PATCH /v1/me/settings": { authz: "self", suite: "src/modules/recommendations/history-flows.http.test.ts" },
  "POST /v1/me/history/pause": { authz: "self", suite: "src/modules/recommendations/history-flows.http.test.ts" },
  "POST /v1/me/recently-viewed": { authz: "self", suite: "src/modules/recommendations/history-flows.http.test.ts" },
  "GET /v1/me/orders/:orderGroupId/tracking": { authz: "resource", suite: "src/modules/hub-consolidation/hub.http.test.ts" },
  "POST /v1/hub/consolidations/:id/dispatch": { authz: "resource", suite: "src/modules/hub-consolidation/hub.http.test.ts" },
  "POST /v1/hub/receipts": { authz: "resource", suite: "src/modules/hub-consolidation/hub.http.test.ts" },
  "GET /v1/feed": { authz: "self", suite: "src/modules/recommendations/recommendations.http.test.ts" },
  "GET /v1/me/recommendations/price-drops": { authz: "self", suite: "src/modules/recommendations/recommendations.http.test.ts" },
  "GET /v1/me/recommendations/restock": { authz: "self", suite: "src/modules/recommendations/recommendations.http.test.ts" },
  "GET /v1/products/:productId/similar": { authz: "public", suite: "src/modules/recommendations/recommendations.http.test.ts" },
  "POST /v1/recommendations/clicks": { authz: "self", suite: "src/modules/recommendations/recommendations.http.test.ts" },
  "GET /v1/resale/listings": { authz: "self", suite: "src/modules/resale-lane/resale.http.test.ts" },
  "GET /v1/resale/listings/:id": { authz: "self", suite: "src/modules/resale-lane/resale.http.test.ts" },
  "GET /v1/seller/stores/:storeId/resale/listings": { authz: "resource", suite: "src/modules/resale-lane/resale.http.test.ts" },
  "POST /v1/hub/resale/listings": { authz: "resource", suite: "src/modules/resale-lane/resale.http.test.ts" },
  "POST /v1/seller/stores/:storeId/resale/listings/:id/withdraw": { authz: "resource", suite: "src/modules/resale-lane/resale.http.test.ts" },
  "DELETE /v1/admin/rewards/challenges/:id": { authz: "resource", suite: "src/modules/rewards/rewards.http.test.ts" },
  "GET /v1/admin/rewards/challenges": { authz: "resource", suite: "src/modules/rewards/rewards.http.test.ts" },
  "GET /v1/admin/rewards/config": { authz: "resource", suite: "src/modules/rewards/rewards.http.test.ts" },
  "GET /v1/games/:game/odds": { authz: "public", suite: "src/modules/rewards/rewards.http.test.ts" },
  "GET /v1/me/rewards": { authz: "self", suite: "src/modules/rewards/rewards.http.test.ts" },
  "POST /v1/admin/games/:game/odds": { authz: "resource", suite: "src/modules/rewards/rewards.http.test.ts" },
  "POST /v1/admin/rewards/challenges": { authz: "resource", suite: "src/modules/rewards/rewards.http.test.ts" },
  "POST /v1/games/:game/play": { authz: "self", suite: "src/modules/rewards/rewards.http.test.ts" },
  "POST /v1/me/coins/convert": { authz: "self", suite: "src/modules/rewards/rewards.http.test.ts" },
  "PUT /v1/admin/rewards/config": { authz: "resource", suite: "src/modules/rewards/rewards.http.test.ts" },
  "POST /v1/stylist/capsule": { authz: "self", suite: "src/modules/stylist/stylist.http.test.ts" },
  "POST /v1/stylist/complete-look": { authz: "self", suite: "src/modules/stylist/stylist.http.test.ts" },
  "POST /v1/stylist/feedback": { authz: "self", suite: "src/modules/stylist/stylist.http.test.ts" },
  "POST /v1/stylist/outfits": { authz: "self", suite: "src/modules/stylist/stylist.http.test.ts" },
  "POST /v1/stylist/outfits/:outfitId/add-to-bag": { authz: "resource", suite: "src/modules/stylist/stylist.http.test.ts" },
  // Phase 3 outfit calendar (spec P3-02). Negative authorization: calendar.http.test.ts "another shopper's event is 404".
  "GET /v1/me/calendar/events": { authz: "self", suite: "src/modules/outfit-calendar/calendar.http.test.ts" },
  "POST /v1/me/calendar/events": { authz: "self", suite: "src/modules/outfit-calendar/calendar.http.test.ts" },
  "DELETE /v1/me/calendar/events": { authz: "self", suite: "src/modules/outfit-calendar/calendar.http.test.ts" },
  "GET /v1/me/calendar/events/:eventId": { authz: "resource", suite: "src/modules/outfit-calendar/calendar.http.test.ts" },
  "PATCH /v1/me/calendar/events/:eventId": { authz: "resource", suite: "src/modules/outfit-calendar/calendar.http.test.ts" },
  "DELETE /v1/me/calendar/events/:eventId": { authz: "resource", suite: "src/modules/outfit-calendar/calendar.http.test.ts" },
  "POST /v1/me/calendar/events/:eventId/outfits": { authz: "resource", suite: "src/modules/outfit-calendar/calendar.http.test.ts" },
  "POST /v1/me/calendar/events/:eventId/add-gap-to-bag": { authz: "resource", suite: "src/modules/outfit-calendar/calendar.http.test.ts" },
  // Phase 3 wardrobe digitization (spec 28 feature 4). Negative authorization: wardrobe.http.test.ts "authorization (BOLA)".
  "GET /v1/me/wardrobe/items": { authz: "self", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "POST /v1/me/wardrobe/items": { authz: "self", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "POST /v1/me/wardrobe/uploads": { authz: "self", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "GET /v1/me/wardrobe/owned-slots": { authz: "self", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "POST /v1/me/wardrobe/complete": { authz: "self", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "DELETE /v1/me/wardrobe": { authz: "self", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "GET /v1/me/wardrobe/items/:itemId": { authz: "resource", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "PATCH /v1/me/wardrobe/items/:itemId": { authz: "resource", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "DELETE /v1/me/wardrobe/items/:itemId": { authz: "resource", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "GET /v1/me/wardrobe/items/:itemId/photo": { authz: "resource", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  "POST /v1/me/wardrobe/items/:itemId/suggest-attributes": { authz: "resource", suite: "src/modules/wardrobe/wardrobe.http.test.ts" },
  // Stylist chat (spec P3-07). Owner-only sessions: foreign or missing ids answer the same 404; a seller actor gets 403.
  "POST /v1/stylist/chat/sessions": { authz: "self", suite: "src/modules/stylist/stylist.chat.http.test.ts" },
  "GET /v1/stylist/chat/sessions": { authz: "self", suite: "src/modules/stylist/stylist.chat.http.test.ts" },
  "GET /v1/stylist/chat/sessions/:sessionId": { authz: "resource", suite: "src/modules/stylist/stylist.chat.http.test.ts" },
  "POST /v1/stylist/chat/sessions/:sessionId/messages": { authz: "resource", suite: "src/modules/stylist/stylist.chat.http.test.ts" },
  "DELETE /v1/stylist/chat/sessions/:sessionId": { authz: "resource", suite: "src/modules/stylist/stylist.chat.http.test.ts" },
  "GET /v1/me/stylist-chat/settings": { authz: "self", suite: "src/modules/stylist/stylist.chat.http.test.ts" },
  "PATCH /v1/me/stylist-chat/settings": { authz: "self", suite: "src/modules/stylist/stylist.chat.http.test.ts" },
  "POST /v1/admin/gift-cards/:id/void": { authz: "resource", suite: "src/modules/gift-cards/gift-cards.admin.http.test.ts" },
  "GET /v1/admin/gift-cards/pots": { authz: "resource", suite: "src/modules/gift-cards/gift-cards.admin.http.test.ts" },
  "GET /v1/admin/gift-cards/throttle-events": { authz: "resource", suite: "src/modules/gift-cards/gift-cards.admin.http.test.ts" },
  "GET /v1/admin/subscriptions/metrics": { authz: "resource", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "GET /v1/admin/calendar": { authz: "self", suite: "src/modules/promotions/test/calendar.test.ts" },
  "PUT /v1/admin/calendar": { authz: "self", suite: "src/modules/promotions/test/calendar.test.ts" },
  "GET /v1/admin/plus/plans": { authz: "resource", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "GET /v1/me/plus": { authz: "self", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "GET /v1/plus/plans": { authz: "self", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "PATCH /v1/admin/plus/plans/:planId": { authz: "resource", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/admin/plus/plans": { authz: "resource", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/plus/cancel": { authz: "self", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/plus/pause": { authz: "self", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/plus/reactivate": { authz: "self", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/plus/refund": { authz: "self", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/plus/resume": { authz: "self", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/plus/subscribe": { authz: "self", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/plus/switch-plan": { authz: "self", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/plus/family": { authz: "self", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "GET /v1/me/plus/family": { authz: "self", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "POST /v1/plus/family/invites": { authz: "self", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "DELETE /v1/plus/family/invites/:memberId": { authz: "self", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "POST /v1/plus/family/invites/:token/accept": { authz: "self", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "DELETE /v1/plus/family/members/:memberId": { authz: "self", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "POST /v1/plus/family/leave": { authz: "self", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "POST /v1/plus/student/verify": { authz: "self", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "POST /v1/plus/student/verify/callback": { authz: "public", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "GET /v1/me/plus/student": { authz: "self", suite: "src/modules/subscriptions/family/family.http.test.ts" },
  "POST /v1/webhooks/:provider/recurring": { authz: "public", suite: "src/modules/subscriptions/subscriptions.http.test.ts" },
  "POST /v1/seller/auth/otp/request": { authz: "public", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/seller/auth/otp/verify": { authz: "public", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/seller/auth/passkey/assert/options": { authz: "public", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/seller/auth/passkey/assert": { authz: "public", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/seller/auth/totp/assert": { authz: "public", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/seller/auth/passkey/register/options": { authz: "self", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/seller/auth/passkey/register": { authz: "self", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/seller/auth/totp/enrol": { authz: "self", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/seller/auth/totp/confirm": { authz: "self", suite: "src/production/seller-auth.production.test.ts" },
  "GET /v1/seller/auth/sessions": { authz: "self", suite: "src/production/seller-auth.production.test.ts" },
  "DELETE /v1/seller/auth/sessions/:sessionId": { authz: "self", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/seller/auth/logout": { authz: "self", suite: "src/production/seller-auth.production.test.ts" },
  "POST /v1/creator/apply": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "GET /v1/creator/dashboard": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/creator/links": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "GET /v1/creator/links": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "DELETE /v1/creator/links/:linkId": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/creator/looks": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "GET /v1/creator/looks": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "PATCH /v1/creator/looks/:lookId": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/creator/looks/:lookId/publish": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "DELETE /v1/creator/looks/:lookId": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "GET /v1/creator/commissions": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "GET /v1/creator/payouts": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/creator/payout-preference": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "GET /v1/c/:handle": { authz: "public", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/affiliate/clicks": { authz: "public", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/affiliate/install-tokens": { authz: "self", suite: "src/modules/creators/test/click-auth.http.test.ts" },
  "GET /v1/admin/creators": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/admin/creators/:id/decision": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/admin/creators/attributions/:id/void": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/admin/creator-looks/:id/takedown": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "GET /v1/admin/creator-payouts": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/admin/creator-payouts": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/admin/creator-payouts/:id/approve": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/admin/creator-payouts/:id/send": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/admin/creator-payouts/:id/outcome": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "POST /v1/admin/creator-payouts/:id/cancel": { authz: "self", suite: "src/modules/creators/test/creators.http.test.ts" },
  "GET /v1/drops/:dropId/queue/status": { authz: "self", suite: "src/modules/drops/drops.http.test.ts" },
  "POST /v1/drops/:dropId/queue": { authz: "self", suite: "src/modules/drops/drops.http.test.ts" },
  "GET /v1/home/banners": { authz: "self", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
  "GET /v1/admin/home-banners": { authz: "resource", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
  "POST /v1/admin/home-banners": { authz: "resource", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
  "GET /v1/admin/home-banners/preview": { authz: "resource", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
  "GET /v1/admin/home-banners/:id": { authz: "resource", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
  "PATCH /v1/admin/home-banners/:id": { authz: "resource", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
  "DELETE /v1/admin/home-banners/:id": { authz: "resource", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
  "POST /v1/admin/home-banners/:id/schedule": { authz: "resource", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
  "POST /v1/admin/home-banners/:id/pause": { authz: "resource", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
  "POST /v1/admin/home-banners/:id/resume": { authz: "resource", suite: "src/modules/home-banners/test/home-banners.http.test.ts" },
};

// ---- Suite ---------------------------------------------------------------------------------

describe("authorization matrix", () => {
  let h: Harness;
  let c: Ctx;
  let routes: Discovered[];

  beforeAll(async () => {
    h = await createHarness({ customise: (b) => b.overrideProvider(JWKS_KEY_FETCHER).useValue(jwks) });
    h.grantAgeGate("key-matrix-device");
    const mk = async (phone: string): Promise<Session> => {
      const l = await login(h, phone);
      return { token: l.accessToken, userId: l.userId, sessionId: l.sessionId, refresh: l.refreshToken };
    };
    c = { h, a: await mk("+201007770001"), b: await mk("+201007770002") };
    routes = discoverRoutes(h);
    await prepareFixtures(c);
  });
  afterAll(async () => h.close());

  describe("route discovery", () => {
    it("finds the implemented routes", () => {
      expect(routes.length).toBeGreaterThan(0);
      expect(new Set(routes.map((r) => r.key)).size).toBe(routes.length);
    });

    it("every discovered route has a matrix entry", () => {
      const missing = routes.map((r) => r.key).filter((k) => MATRIX[k] === undefined && DELEGATED[k] === undefined);
      expect(missing, `routes without a matrix entry: ${missing.join(", ")}`).toEqual([]);
    });

    it("every matrix entry is a real route (no stale rows)", () => {
      const found = new Set(routes.map((r) => r.key));
      const stale = [...Object.keys(MATRIX), ...Object.keys(DELEGATED)].filter((k) => !found.has(k));
      expect(stale, `matrix rows without a route: ${stale.join(", ")}`).toEqual([]);
    });

    it("every route declares an authorization mode and it matches the matrix", () => {
      for (const r of routes) {
        expect(r.meta, `${r.key} has no @Public/@AuthenticatedSelf/@Authorize`).toBeDefined();
        expect(r.meta?.kind, r.key).toBe((MATRIX[r.key] ?? DELEGATED[r.key])?.authz);
      }
    });

    it("every implemented route is described by docs/api/openapi.yaml", () => {
      const ops = new Set(openApiOperations());
      // Path parameter names are not part of the contract (Nest `:id` vs OpenAPI `{orderGroupId}`).
      const norm = (k: string): string => k.replace(/:\w+/g, ":p");
      const notInSpec = routes.map((r) => norm(r.key)).filter((k) => !ops.has(k));
      // Health probes are operational endpoints, intentionally outside the product contract.
      expect(notInSpec.filter((k) => !/\/v1\/(health|ready)$/.test(k))).toEqual([]);
    });

    it("docs/security/authz-matrix.md lists every implemented route", () => {
      const doc = readFileSync(resolve(REPO, "docs/security/authz-matrix.md"), "utf8");
      const missing = routes.map((r) => r.key).filter((k) => !doc.includes(`\`${k}\``));
      expect(missing).toEqual([]);
    });
  });

  const entries = Object.entries(MATRIX);
  const tokenFor = (e: Entry): string => (e.aud === "seller_api" ? SELLER_TOKEN : c.a.token);
  const protectedEntries = entries.filter(([, e]) => e.authz !== "public");
  const publicEntries = entries.filter(([, e]) => e.authz === "public");

  describe("wave 3 delegated routes", () => {
    const delegated = Object.entries(DELEGATED);
    it.each(delegated.map(([k]) => k))("%s: owning suite exists and no credentials is never a 5xx", async (key) => {
      const d = DELEGATED[key];
      if (d === undefined) throw new Error("unreachable");
      const suiteSrc = readFileSync(resolve(HERE, "..", d.suite), "utf8");
      expect(suiteSrc).toMatch(/40[134]/);
      const [verb = "GET", path = ""] = key.split(" ");
      const url = path.replace(/:\w+/g, MISSING_ID);
      const agent = c.h.http();
      const req = verb === "GET" ? agent.get(url) : verb === "DELETE" ? agent.delete(url) : verb === "PATCH" ? agent.patch(url).send({}) : verb === "PUT" ? agent.put(url).send({}) : agent.post(url).send({});
      const r = await req;
      // Public reads (reviews, Q&A lists) legitimately answer 200 without credentials.
      if (d.authz === "public") expect(verb === "GET" ? [200, 400, 401, 403, 404, 415, 422] : [400, 401, 403, 404, 415, 422]).toContain(r.status);
      else expect(r.status).toBe(401);
    });
  });

  describe("(a) unauthenticated", () => {
    it.each(protectedEntries.map(([k]) => k))("%s -> 401 with a clean problem body", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      const r = await e.send(c, null);
      expect(r.status).toBe(401);
      expect(r.headers["www-authenticate"]).toContain("Bearer");
      expect(r.body.type).toBe("/problems/unauthenticated");
      expect(Object.keys(r.body).filter((k) => !PROBLEM_KEYS.includes(k))).toEqual([]);
    });

    it.each(protectedEntries.map(([k]) => k))("%s -> 401 for a malformed or unknown bearer token", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      for (const t of ["not-a-token", "dev_" + "0".repeat(64)]) {
        const r = await e.send(c, t);
        expect(r.status, `${key} with ${t.slice(0, 8)}`).toBe(401);
      }
    });

    it.each(publicEntries.map(([k]) => k))("%s is reachable without credentials (declared @Public)", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      const r = await e.send(c, null);
      expect(r.status, `${key} -> ${JSON.stringify(r.body)}`).toBe(e.okStatus);
    });
  });

  describe("(b) wrong audience / not active", () => {
    it.each(protectedEntries.map(([k]) => k))("%s -> 401 for a token of the other audience, 403 for a suspended subject", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      const authn = h.app.get<Authenticator>(AUTHENTICATOR, { strict: false });
      const issuer = authn as unknown as { issue(claims: unknown): Promise<string> };
      const claims = buildAccessClaims({
        issuer: h.config.tokenIssuer,
        userId: c.a.userId,
        audience: e.aud === "seller_api" ? "buyer_api" : "seller_api",
        sessionId: c.a.sessionId,
        jti: `jti-matrix-${key}`,
        amr: ["otp_sms"],
        nowMs: h.clock.nowMs(),
      });
      const sellerToken = await issuer.issue(claims);
      const wrongAud = await e.send(c, sellerToken);
      expect(wrongAud.status).toBe(401);

      const original = authn.authenticate.bind(authn);
      authn.authenticate = async (t, n) => {
        const p = await original(t, n);
        return p === null ? null : { ...p, actor: { ...p.actor, status: "suspended" } };
      };
      try {
        const suspended = await e.send(c, tokenFor(e));
        expect(suspended.status).toBe(403);
        if (e.aud !== "seller_api") expect(suspended.body.code).toBe("account_not_active");
      } finally {
        authn.authenticate = original;
      }
    });
  });

  describe("(c) another user's object", () => {
    const objectEntries = entries.filter(([, e]) => e.objectId === true);
    it("the matrix has object-id routes to test", () => {
      expect(objectEntries.length).toBeGreaterThan(0);
    });

    it.each(objectEntries.map(([k]) => k))("%s -> 404 for a foreign object, same body as a missing one", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      const foreign = await e.send(c, tokenFor(e), "foreign");
      const missing = await e.send(c, tokenFor(e), "missing");
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      const strip = (b: Record<string, unknown>) => {
        const { request_id: _r, ...rest } = b;
        return rest;
      };
      expect(strip(foreign.body)).toEqual(strip(missing.body));
    });

    it("a foreign DELETE has no side effect: the owner's session still works", async () => {
      const del = await c.h.http().delete(`/v1/me/sessions/${c.b.sessionId}`).set(bearer(c.a.token));
      expect(del.status).toBe(404);
      const still = await c.h.http().get("/v1/me/sessions").set(bearer(c.b.token));
      expect(still.status).toBe(200);
    });

    it("sessions list never contains another user's sessions", async () => {
      const r = await c.h.http().get("/v1/me/sessions").set(bearer(c.a.token));
      const ids = (r.body.items as { id: string }[]).map((s) => s.id);
      expect(ids).toContain(c.a.sessionId);
      expect(ids).not.toContain(c.b.sessionId);
    });

    it("a passkey registration challenge issued to another user is a 404 and stays usable by its owner", async () => {
      const opts = await h.http().post("/v1/auth/passkey/register/options").set(bearer(c.b.token)).send({});
      expect(opts.status).toBe(200);
      const credential = (id: string) => ({ id, credentialId: id, publicKey: `pk-${id}`, signCount: 0, origin: "https://outletnk.invalid", challenge: opts.body.challenge });
      const stolen = await h
        .http()
        .post("/v1/auth/passkey/register")
        .set(bearer(c.a.token))
        .send({ challenge_id: opts.body.challenge_id, credential: credential("cred-stolen-1") });
      expect(stolen.status).toBe(404);
      const own = await h
        .http()
        .post("/v1/auth/passkey/register")
        .set(bearer(c.b.token))
        .send({ challenge_id: opts.body.challenge_id, credential: credential("cred-owner-matrix-1") });
      expect(own.status).toBe(204);
    });

    it("an owner-only read by a stranger token is refused after the owner signs out (revoked object is gone)", async () => {
      const l = await login(h, "+201007770003");
      const out = await h.http().post("/v1/auth/logout").set(bearer(l.accessToken));
      expect(out.status).toBe(204);
      const r = await h.http().get(`/v1/me/sessions/${l.sessionId}`).set(bearer(c.a.token));
      expect(r.status).toBe(404);
    });
  });

  describe("(d) response bodies carry only allow-listed fields", () => {
    const strictKeys = (body: unknown, allowed: readonly string[], where: string): void => {
      if (body === null || typeof body !== "object" || Array.isArray(body)) return;
      const extra = Object.keys(body).filter((k) => !allowed.includes(k));
      expect(extra, `${where} leaks fields ${extra.join(", ")}`).toEqual([]);
    };

    it.each(entries.map(([k]) => k))("%s", async (key) => {
      const e = MATRIX[key];
      if (e === undefined) throw new Error("unreachable");
      let ctx = c;
      if (e.consumesSession === true) {
        const l = await login(h, `+2010077${String(Math.floor(Math.random() * 90000) + 10000)}`);
        ctx = { ...c, a: { token: l.accessToken, userId: l.userId, sessionId: l.sessionId, refresh: l.refreshToken } };
      }
      const token = e.authz === "public" ? null : e.aud === "seller_api" ? SELLER_TOKEN : ctx.a.token;
      const r = e.prepare !== undefined && token !== null ? await (await e.prepare(ctx, token))() : await e.send(ctx, token);
      expect(r.status, `${key} -> ${JSON.stringify(r.body)}`).toBe(e.okStatus);
      if (e.okStatus === 204) {
        expect(r.text).toBe("");
        return;
      }
      strictKeys(r.body, e.okKeys, key);
      const text = JSON.stringify(r.body);
      for (const forbidden of ["password", "refresh_hash", "otp_hash", "pepper", "phone_e164", "dob", "device_id_hash", "stack"]) {
        expect(text.includes(`"${forbidden}"`), `${key} exposes ${forbidden}`).toBe(false);
      }
      if (key === "POST /v1/auth/google") {
        strictKeys((r.body as { user: unknown }).user, USER_KEYS, `${key} user`);
      }
      if (key === "GET /v1/me/sessions") {
        for (const s of (r.body as { items: unknown[] }).items) {
          strictKeys(s, ["id", "platform", "created_at", "last_seen_at", "current"], `${key} item`);
        }
      }
    });

    it("validation errors do not echo the submitted values", async () => {
      const secret = "SENSITIVE-VALUE-12345";
      const r = await h.http().patch("/v1/me/privacy/consents").set(bearer(c.a.token)).send({ changes: [{ purpose: secret, granted: "yes" }] });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).not.toContain(secret);
      strictKeys(r.body, PROBLEM_KEYS, "validation problem");
    });

    it("an unknown route is a clean 404 problem, not a framework error page", async () => {
      const r = await h.http().get("/v1/definitely/not/here").set(bearer(c.a.token));
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toMatch(/Cannot GET|stack|node_modules/);
    });
  });
});
