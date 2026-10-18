import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/env";
import { ChannelOdooModule, MissingOdooPortsError } from "./index";
import { API_KEY, KMS_REF, LOGIN, STORE_A, STORE_B, TARGET_A, TOKEN_REF } from "./test/harness";
import { TOKENS, bearer, createOdooHttpHarness, type OdooHttpHarness } from "./test/http-harness";

let h: OdooHttpHarness;
let seq = 0;
const idem = (): Record<string, string> => ({ "Idempotency-Key": `00000000-0000-7000-8000-${String(++seq).padStart(12, "0")}` });
beforeEach(async () => {
  h = await createOdooHttpHarness();
});
afterEach(async () => {
  await h.close();
});

const url = (store: string): string => `/v1/seller/stores/${store}/odoo-channels`;
const body = { target_id: TARGET_A, database: "haul_prod", token_ref: TOKEN_REF, kms_key_ref: KMS_REF, pricelist_id: 5, poll_interval_seconds: 900 };
const create = (token: string | null, store = STORE_A, b: unknown = body, key = idem()) => {
  const r = h.http().post(url(store)).set(key);
  return (token === null ? r : r.set(bearer(token))).send(b as object);
};

describe("connect, list, test, disconnect", () => {
  it("owner connects; the response never echoes secret references or credentials", async () => {
    const r = await create(TOKENS.ownerA);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ kind: "odoo", status: "active", database: "haul_prod", target_id: TARGET_A, has_secret: true, pricelist_id: 5 });
    const text = JSON.stringify(r.body);
    for (const bad of [TOKEN_REF, KMS_REF, API_KEY, LOGIN, "vault://", "kms://"]) expect(text).not.toContain(bad);
    const list = await h.http().get(url(STORE_A)).set(bearer(TOKENS.managerA));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("vault://");
    const t = await h.http().post(`${url(STORE_A)}/${r.body.id as string}/test`).set(idem()).set(bearer(TOKENS.ownerA)).send({});
    expect(t.status).toBe(200);
    expect(t.body).toEqual({ result: "ok", code: null });
    const del = await h.http().delete(`${url(STORE_A)}/${r.body.id as string}`).set(idem()).set(bearer(TOKENS.ownerA));
    expect(del.status).toBe(204);
    const after = await h.http().get(url(STORE_A)).set(bearer(TOKENS.ownerA));
    expect(after.body.items[0].status).toBe("revoked");
  });

  it("replaying the same Idempotency-Key returns the same channel", async () => {
    const key = idem();
    const a = await create(TOKENS.ownerA, STORE_A, body, key);
    const b = await create(TOKENS.ownerA, STORE_A, body, key);
    expect(b.status).toBe(a.status);
    expect(b.body.id).toBe(a.body.id);
    expect(h.directory.channels.size).toBe(1);
  });

  it("validates input: unknown fields, bad refs, unverified target, missing secret, missing key", async () => {
    expect((await create(TOKENS.ownerA, STORE_A, { ...body, api_key: "x" })).status).toBe(400);
    expect((await create(TOKENS.ownerA, STORE_A, { ...body, token_ref: "short" })).status).toBe(400);
    expect((await create(TOKENS.ownerA, STORE_A, { ...body, poll_interval_seconds: 5 })).status).toBe(400);
    expect((await create(TOKENS.ownerA, STORE_A, { ...body, target_id: "00000000-0000-4000-b000-0000000000aa" })).status).toBe(400);
    h.secrets.refs.delete(TOKEN_REF);
    expect((await create(TOKENS.ownerA)).status).toBe(400);
    const noKey = await h.http().post(url(STORE_A)).set(bearer(TOKENS.ownerA)).send(body);
    expect(noKey.status).toBe(400);
    expect(h.server.seen).toHaveLength(0);
  });

  it("kill switch returns 503 and sends nothing", async () => {
    h.flags.on = false;
    const r = await create(TOKENS.ownerA);
    expect(r.status).toBe(503);
    expect(h.server.seen).toHaveLength(0);
  });
});

describe("authorization", () => {
  it("another store's owner gets 404 everywhere and cannot reach a foreign channel through their own store path", async () => {
    const own = await create(TOKENS.ownerA);
    const id = own.body.id as string;
    expect((await create(TOKENS.ownerB, STORE_A)).status).toBe(404);
    expect((await h.http().get(url(STORE_A)).set(bearer(TOKENS.ownerB))).status).toBe(404);
    expect((await h.http().post(`${url(STORE_A)}/${id}/test`).set(idem()).set(bearer(TOKENS.ownerB)).send({})).status).toBe(404);
    expect((await h.http().delete(`${url(STORE_A)}/${id}`).set(idem()).set(bearer(TOKENS.ownerB))).status).toBe(404);
    // BOLA: own store path, foreign channel id.
    expect((await h.http().post(`${url(STORE_B)}/${id}/test`).set(idem()).set(bearer(TOKENS.ownerB)).send({})).status).toBe(404);
    expect((await h.http().delete(`${url(STORE_B)}/${id}`).set(idem()).set(bearer(TOKENS.ownerB))).status).toBe(404);
    const still = await h.http().get(url(STORE_A)).set(bearer(TOKENS.ownerA));
    expect(still.body.items[0].status).toBe("active");
  });

  it("staff without the settings right get 403; shoppers, wrong audience and anonymous callers are refused", async () => {
    expect((await create(TOKENS.catalogA)).status).toBe(403);
    expect((await h.http().get(url(STORE_A)).set(bearer(TOKENS.catalogA))).status).toBe(403);
    expect((await create(TOKENS.shopper)).status).toBe(403);
    expect((await create(TOKENS.ownerOnBuyerAud)).status).toBe(401);
    expect((await create(null)).status).toBe(401);
    expect((await h.http().get(url(STORE_A))).status).toBe(401);
    expect((await h.http().delete(`${url(STORE_A)}/00000000-0000-4000-d000-000000000001`).set(idem())).status).toBe(401);
  });
});

describe("module boot", () => {
  it("refuses to boot outside test mode without real ports", () => {
    expect(() => ChannelOdooModule.forRoot(loadConfig({ NODE_ENV: "development" }))).toThrow(MissingOdooPortsError);
  });
});
