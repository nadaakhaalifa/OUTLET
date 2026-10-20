import "reflect-metadata";
import { Global, Module, type DynamicModule } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { AccessClaims } from "@outlet/auth-core";
import type { Actor } from "@outlet/policy";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configureApp } from "../../../app.setup";
import { loadConfig } from "../../../config/env";
import { AUTHENTICATOR, PlatformModule, createIdGenerator, nodeCsprng, type Authenticator } from "../../../platform";
import { signedDeviceHash, unsignedDeviceHash, issueInstallToken, verifyInstallToken } from "../adapters/install-token";
import { InMemoryCreatorCatalog, InMemoryCreatorIdentity, InMemoryCreatorLedger, InMemoryCreatorStore, StaticCreatorFlags } from "../adapters/in-memory";
import { ATTRIBUTE_ORDER } from "../adapters/tokens";
import type { AttributeOrder } from "../application/links";
import { CreatorsModule } from "../creators.module";
import type { CreatorProfileView } from "../domain/ports";
import { T0, U, account, kyc, link } from "./repository-contract";

const SALT = "click-auth-test-salt-0123456789-abcdef";
const BUYER_DEVICE = "buyer-device-0000000001";
const OTHER_DEVICE = "attacker-device-00000002";
const APP_UA = "Mozilla/5.0 OutletApp/1.0";
const TOKEN = "tok-shopper-click-auth-0001";
const SELLER_TOKEN = "tok-seller-click-auth-0001";

class Clock {
  ms = T0;
  nowMs(): number {
    return this.ms;
  }
}
class Tokens implements Authenticator {
  private readonly m = new Map<string, { actor: Actor; aud: AccessClaims["aud"] }>();
  add(token: string, actor: Actor, aud: AccessClaims["aud"]): void {
    this.m.set(token, { actor, aud });
  }
  async authenticate(b: string, nowMs: number) {
    const s = this.m.get(b);
    if (s === undefined) return null;
    const iat = Math.floor(nowMs / 1000);
    const claims: AccessClaims = { iss: "test", sub: s.actor.id, aud: s.aud, iat, exp: iat + 600, jti: `j-${b}`, sid: `s-${b}`, amr: ["otp_sms"] };
    return { actor: s.actor, claims };
  }
}
const profile = (userId: string, o: Partial<CreatorProfileView> = {}): CreatorProfileView => ({
  userId,
  ageYears: 30,
  active: true,
  deviceHashes: [],
  paymentFingerprintHashes: [],
  addressHashes: [],
  sellerStoreIds: [],
  ...o,
});

const clock = new Clock();
const store = new InMemoryCreatorStore();
const identity = new InMemoryCreatorIdentity();
let app: ReturnType<ReturnType<typeof Test.createTestingModule>["compile"]> extends Promise<infer M> ? (M extends { createNestApplication: () => infer A } ? A : never) : never;
let attribute: AttributeOrder;
let slug = "";
const http = () => request(app.getHttpServer());
let orderN = 0;

/** Registers a device to the minting session's user (U(70)), as a login would. */
const registerDevice = (deviceId: string, userId: string = U(70)): void => {
  const cur = identity.profiles.get(userId) ?? profile(userId);
  identity.profiles.set(userId, { ...cur, deviceHashes: [...cur.deviceHashes, signedDeviceHash(SALT, deviceId)] });
};
const mintToken = async (deviceId: string): Promise<string> => {
  registerDevice(deviceId);
  const r = await http().post("/v1/affiliate/install-tokens").set("Authorization", `Bearer ${TOKEN}`).set("x-device-id", deviceId).send({ device_id: deviceId });
  expect(r.status).toBe(201);
  return r.body.install_token as string;
};
const click = (deviceId: string, token: string | null, ua = APP_UA) => {
  let r = http().post("/v1/affiliate/clicks").set("User-Agent", ua).set("x-device-id", deviceId);
  if (token !== null) r = r.set("x-install-token", token);
  return r.send({ slug, device_id: deviceId });
};
/** A fresh buyer whose registered device is BUYER_DEVICE places an order now. */
async function order(deviceId: string = BUYER_DEVICE) {
  orderN += 1;
  const buyer = U(500 + orderN);
  identity.profiles.set(buyer, profile(buyer, { deviceHashes: [signedDeviceHash(SALT, deviceId)] }));
  clock.ms += 1_000;
  return attribute.execute({ orderGroupId: U(900 + orderN), buyerUserId: buyer, orderAtMs: clock.ms });
}

beforeAll(async () => {
  const config = loadConfig({ NODE_ENV: "test" });
  const tokens = new Tokens();
  tokens.add(TOKEN, { id: U(70), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] }, "buyer_api");
  tokens.add(SELLER_TOKEN, { id: U(70), status: "active", assurance: "basic", grants: [{ kind: "shopper" }], tokenScopes: [] }, "seller_api");
  @Global()
  @Module({})
  class TestAuth {
    static register(): DynamicModule {
      return { module: TestAuth, providers: [{ provide: AUTHENTICATOR, useValue: tokens }], exports: [AUTHENTICATOR] };
    }
  }
  const a = account(1, U(1));
  await store.createAccount(a, kyc(1), []);
  const l = link(1, a.id);
  await store.insertLink(l, []);
  slug = l.slug;
  identity.profiles.set(U(1), profile(U(1)));
  const m = await Test.createTestingModule({
    imports: [
      PlatformModule.forRoot(config, { clock, ids: createIdGenerator(clock, nodeCsprng) }),
      TestAuth.register(),
      CreatorsModule.forRoot(config, {
        store,
        identity,
        catalog: new InMemoryCreatorCatalog(),
        ledger: new InMemoryCreatorLedger(),
        flags: new StaticCreatorFlags(true, false),
        clickSalt: SALT,
      }),
    ],
  }).compile();
  app = m.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  attribute = app.get<AttributeOrder>(ATTRIBUTE_ORDER, { strict: false });
}, 60_000);
afterAll(async () => {
  await app.close();
});

describe("install token unit rules", () => {
  const now = T0;
  const t = issueInstallToken({ salt: SALT, deviceId: BUYER_DEVICE, nowMs: now });
  const verify = (token: string | undefined, deviceId = BUYER_DEVICE, at = now + 1000, salt = SALT) => verifyInstallToken({ salt, token, deviceId, nowMs: at });

  it("accepts a fresh token for its own device and nothing else", () => {
    expect(verify(t.token)).toBe("valid");
    expect(verify(t.token, OTHER_DEVICE)).toBe("device_mismatch");
    expect(verify(t.token, BUYER_DEVICE, t.expiresAtMs)).toBe("expired");
    expect(verify(t.token, BUYER_DEVICE, now - 120_000)).toBe("not_yet_valid");
    expect(verify(undefined)).toBe("absent");
    expect(verify("")).toBe("absent");
    expect(verify(t.token, BUYER_DEVICE, now + 1000, "another-salt-another-salt-another-salt")).toBe("bad_signature");
  });

  it("refuses malformed, truncated, re-signed and payload-edited tokens", () => {
    const [v, payload = "", mac = ""] = t.token.split(".");
    expect(verify("garbage")).toBe("malformed");
    expect(verify(`${v}.${payload}`)).toBe("malformed");
    expect(verify(`${v}.${payload}.${mac}.x`)).toBe("malformed");
    expect(verify(`v2.${payload}.${mac}`)).toBe("malformed");
    expect(verify(`${v}.${payload}.${mac.slice(0, -2)}AA`)).toBe("bad_signature");
    const edited = Buffer.from(JSON.stringify({ v: 1, did: signedDeviceHash(SALT, OTHER_DEVICE), iat: now, exp: now + 9_999_999_999, n: "x" })).toString("base64url");
    expect(verify(`${v}.${edited}.${mac}`, OTHER_DEVICE)).toBe("bad_signature");
    expect(verify("a".repeat(600))).toBe("malformed");
  });

  it("signed and unsigned click hashes are domain separated and never collide", () => {
    expect(signedDeviceHash(SALT, BUYER_DEVICE)).not.toBe(unsignedDeviceHash(SALT, BUYER_DEVICE));
    expect(signedDeviceHash(SALT, BUYER_DEVICE)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("POST /v1/affiliate/install-tokens", () => {
  it("is authenticated: 401 anonymously and with a token of another audience; strict body; no-store", async () => {
    expect((await http().post("/v1/affiliate/install-tokens").send({ device_id: BUYER_DEVICE })).status).toBe(401);
    expect((await http().post("/v1/affiliate/install-tokens").set("Authorization", `Bearer ${SELLER_TOKEN}`).send({ device_id: BUYER_DEVICE })).status).toBe(401);
    const bad = await http().post("/v1/affiliate/install-tokens").set("Authorization", `Bearer ${TOKEN}`).send({ device_id: BUYER_DEVICE, user_id: U(1) });
    expect(bad.status).toBe(400);
    registerDevice(BUYER_DEVICE);
    const ok = await http().post("/v1/affiliate/install-tokens").set("Authorization", `Bearer ${TOKEN}`).send({ device_id: BUYER_DEVICE });
    expect(ok.status).toBe(201);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.body.install_token).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    expect(Date.parse(ok.body.expires_at)).toBe(clock.ms + 15 * 60_000);
    // The raw device id is never inside the token (only its keyed hash).
    const payload = Buffer.from(String(ok.body.install_token).split(".")[1] ?? "", "base64url").toString("utf8");
    expect(payload).not.toContain(BUYER_DEVICE);
  });
});

describe("A-1: install token mint is bound to the caller's own devices", () => {
  const VICTIM = U(71);
  const VICTIM_DEVICE = "victim-device-00000000001";
  const mint = (device: string, header = true) => {
    let r = http().post("/v1/affiliate/install-tokens").set("Authorization", `Bearer ${TOKEN}`);
    if (header) r = r.set("x-device-id", device);
    return r.send({ device_id: device });
  };

  it("404 for a device registered to another user, identical to an unknown device (no oracle)", async () => {
    registerDevice(VICTIM_DEVICE, VICTIM);
    const foreign = await mint(VICTIM_DEVICE);
    const unknown = await mint("never-registered-device-01");
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect({ ...foreign.body, request_id: "" }).toEqual({ ...unknown.body, request_id: "" });
    expect(JSON.stringify(foreign.body)).not.toContain("install_token");
  });

  it("404 when the header names a foreign device even if the body names an own one", async () => {
    registerDevice("my-own-device-000000001");
    registerDevice(VICTIM_DEVICE, VICTIM);
    const r = await http().post("/v1/affiliate/install-tokens").set("Authorization", `Bearer ${TOKEN}`).set("x-device-id", VICTIM_DEVICE).send({ device_id: "my-own-device-000000001" });
    expect(r.status).toBe(404);
  });

  it("404 when the caller has no identity profile at all", async () => {
    const saved = identity.profiles.get(U(70));
    identity.profiles.delete(U(70));
    try {
      expect((await mint(BUYER_DEVICE)).status).toBe(404);
    } finally {
      if (saved !== undefined) identity.profiles.set(U(70), saved);
    }
  });

  it("a victim's later order is not attributed to a click made with a token the attacker could not mint", async () => {
    registerDevice(VICTIM_DEVICE, VICTIM);
    expect((await mint(VICTIM_DEVICE)).status).toBe(404);
    expect((await click(VICTIM_DEVICE, null)).status).toBe(202);
    identity.profiles.set(U(510), profile(U(510), { deviceHashes: [signedDeviceHash(SALT, VICTIM_DEVICE)] }));
    clock.ms += 1_000;
    const r = await attribute.execute({ orderGroupId: U(990), buyerUserId: U(510), orderAtMs: clock.ms });
    expect(r.kind).toBe("none");
  });
});

describe("click attribution eligibility", () => {
  // Each case uses its own device id: the fraud gate (rightly) voids two buyers on one device.
  const dev = (n: number): string => `case-device-${String(n).padStart(10, "0")}`;
  const creatorId = async (): Promise<string> => (await store.getByUser(U(1)))?.id ?? "";

  it("a click with a valid install token for the buyer's device attributes the order", async () => {
    const token = await mintToken(dev(1));
    expect((await click(dev(1), token)).status).toBe(202);
    expect((await order(dev(1))).kind).toBe("attributed");
  });

  it("an unsigned click is stored and counted but never eligible", async () => {
    const before = (await store.clickStats(await creatorId(), 0)).total;
    const r = await click(dev(2), null);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ target_type: "product" });
    const after = (await store.clickStats(await creatorId(), 0)).total;
    expect(after).toBe(before + 1);
    expect((await order(dev(2))).kind).toBe("none");
  });

  it("forged, truncated and re-signed tokens are treated as unsigned", async () => {
    const good = await mintToken(dev(3));
    const [v, payload = "", mac = ""] = good.split(".");
    for (const forged of [`${v}.${payload}.${mac.slice(0, -3)}AAA`, "v1.e30.AAAA", "not-a-token", `${v}.${payload}`]) {
      expect((await click(dev(3), forged)).status).toBe(202);
    }
    expect((await order(dev(3))).kind).toBe("none");
  });

  it("an expired token is treated as unsigned", async () => {
    const token = await mintToken(dev(4));
    clock.ms += 16 * 60_000;
    expect((await click(dev(4), token)).status).toBe(202);
    expect((await order(dev(4))).kind).toBe("none");
  });

  it("replay: a captured token presented with another device id never attributes that device", async () => {
    const victimToken = await mintToken(dev(5));
    expect((await click(dev(6), victimToken)).status).toBe(202);
    expect((await order(dev(6))).kind).toBe("none");
    // A replay by the owner inside the lifetime is harmless: the second click is deduped.
    expect((await click(dev(5), victimToken)).status).toBe(202);
    expect((await click(dev(5), victimToken)).status).toBe(202);
    expect((await order(dev(5))).kind).toBe("attributed");
  });

  it("hijack attempt (review A-1): a later click that only knows the buyer's device id cannot displace the legitimate attribution", async () => {
    const second = account(2, U(2), { handle: "creator_2" });
    await store.createAccount(second, kyc(2), []);
    const l2 = link(2, second.id);
    await store.insertLink(l2, []);
    identity.profiles.set(U(2), profile(U(2)));
    const legit = await mintToken(dev(7));
    expect((await click(dev(7), legit)).status).toBe(202);
    clock.ms += 60_000;
    // Creator 2's link, posted by someone who knows the device id, with no token.
    await http().post("/v1/affiliate/clicks").set("User-Agent", APP_UA).set("x-device-id", dev(7)).send({ slug: l2.slug, device_id: dev(7) });
    const r = await order(dev(7));
    expect(r.kind).toBe("attributed");
    if (r.kind === "attributed") expect(r.attribution.linkId).toBe(U(201));
  });
});
