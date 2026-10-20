/**
 * Provider verification: boots the real Nest AppModule (in-memory adapters, same configureApp as
 * main.ts) via apps/api/src/test/harness.ts and replays every consumer interaction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ATTEST_HEADERS, createHarness, login, type Harness, type LoggedIn } from "../../../../apps/api/src/test/harness";
import { CONSUMER, MOBILE_INTERACTIONS, PROVIDER } from "../consumer/mobile-contracts";
import { loadOpenApi, responseDoc, validate } from "../openapi";
import { buildPact, matchBody, writePact, type PactInteraction } from "../pact-dsl";
import { join } from "node:path";

const doc = loadOpenApi();
const pact = buildPact(CONSUMER, PROVIDER, MOBILE_INTERACTIONS);
writePact(join(import.meta.dirname, "../../pacts", `${CONSUMER}-${PROVIDER}.json`), pact);

/**
 * Pending interactions (Pact "pending pacts"): the consumer expects it, the provider does not
 * deliver it yet. A pending interaction that starts passing FAILS this suite so the entry is removed.
 */
const PENDING: Readonly<Record<string, string>> = {};

let h: Harness;
let me: LoggedIn;

beforeAll(async () => {
  h = await createHarness();
  me = await login(h);
});
afterAll(async () => {
  await h.close();
});

async function replay(i: PactInteraction) {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(i.request.headers ?? {})) {
    headers[k] = v === "Bearer <access-token>" ? `Bearer ${me.accessToken}` : v === "<attest>" ? ATTEST_HEADERS["X-App-Attest"] : v;
  }
  const query = i.request.query ?? {};
  const qs = new URLSearchParams(query).toString();
  const url = `${i.request.path}${qs === "" ? "" : `?${qs}`}`;
  let r = h.http();
  const call = (() => {
    switch (i.request.method) {
      case "GET": return r.get(url);
      case "POST": return r.post(url);
      case "PATCH": return r.patch(url);
      case "PUT": return r.put(url);
      default: return r.delete(url);
    }
  })();
  r = undefined as never;
  const res = await call.set(headers).send(i.request.body as object | undefined);
  return res;
}

function verify(i: PactInteraction, res: Awaited<ReturnType<typeof replay>>): string[] {
  const errs: string[] = [];
  if (res.status !== i.response.status) errs.push(`status: expected ${i.response.status}, got ${res.status}`);
  for (const [k, v] of Object.entries(i.response.headers ?? {})) {
    const actual = res.headers[k.toLowerCase()] as string | undefined;
    if (actual === undefined) errs.push(`header ${k}: missing`);
    else {
      const rule = i.response.matchingRules?.[`$.header.${k}`]?.matchers[0];
      if (rule?.match === "regex" && !new RegExp(rule.regex).test(actual)) errs.push(`header ${k}: "${actual}" !~ /${rule.regex}/`);
      if (rule === undefined && actual !== v) errs.push(`header ${k}: expected ${v}`);
    }
  }
  if (i.response.body !== undefined) errs.push(...matchBody(i.response.body, res.body, i.response.matchingRules));
  // Provider-owned truth: the real response must also satisfy the published OpenAPI document.
  const rd = responseDoc(doc, i.metadata.openapi, res.status);
  if (rd === null) errs.push(`openapi: status ${res.status} undeclared for ${i.metadata.openapi}`);
  else {
    const ct = String(res.headers["content-type"] ?? "");
    if (rd.mediaType !== null && !ct.startsWith(rd.mediaType)) errs.push(`openapi: content-type "${ct}" != ${rd.mediaType}`);
    if (rd.schema !== null) errs.push(...validate(doc, rd.schema, res.body).map((e) => `openapi: ${e}`));
    if (res.status < 300) for (const hn of Object.keys(rd.headers)) {
      if (["etag", "x-request-id"].includes(hn) && res.headers[hn] === undefined) errs.push(`openapi: documented header ${hn} absent`);
    }
  }
  return errs;
}

describe("provider verifies outlet-mobile pact", () => {
  for (const i of pact.interactions) {
    const pending = PENDING[i.description];
    it(`${pending !== undefined ? "[pending] " : ""}${i.description}`, async () => {
      const errs = verify(i, await replay(i));
      if (pending !== undefined) {
        expect(errs.length, `pending interaction now passes; remove from PENDING (${pending})`).toBeGreaterThan(0);
      } else {
        expect(errs).toEqual([]);
      }
    });
  }
});

describe("cross-cutting HTTP contract", () => {
  const IDEM = "0192f3a4-5b6c-7d8e-9f01-23456789abd1";
  const auth = () => ({ Authorization: `Bearer ${me.accessToken}` });

  it("every response carries X-Request-Id and Problem+JSON errors repeat it in the body", async () => {
    const r = await h.http().get("/v1/cart");
    expect(r.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(r.headers["x-request-id"]).toBe(r.body.request_id);
  });

  it("an idempotent write replays the stored response and flags Idempotent-Replayed", async () => {
    // A fresh user: the shared session already has a queued export, which would short-circuit with 200.
    const fresh = await login(h, "+201005550777");
    const a = { Authorization: `Bearer ${fresh.accessToken}` };
    const first = await h.http().post("/v1/me/privacy/export").set(a).set("Idempotency-Key", IDEM).send({});
    const second = await h.http().post("/v1/me/privacy/export").set(a).set("Idempotency-Key", IDEM).send({});
    expect(first.status).toBe(202);
    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
  });

  it("same Idempotency-Key with a different body is 422 idempotency-key-reuse", async () => {
    const key = "0192f3a4-5b6c-7d8e-9f01-23456789abd2";
    const a = await h.http().post("/v1/me/privacy/delete").set(auth()).set("Idempotency-Key", key).send({});
    expect([200, 201, 202, 204, 400, 403, 409, 422]).toContain(a.status);
    const b = await h.http().post("/v1/me/privacy/delete").set(auth()).set("Idempotency-Key", key).send({ reason: "different" });
    expect(b.status).toBe(422);
    expect(b.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(b.body.code).toBe("idempotency_key_reuse");
  });

  it("a malformed Idempotency-Key is 400", async () => {
    const r = await h.http().post("/v1/me/privacy/export").set(auth()).set("Idempotency-Key", "not-a-uuid").send({});
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("invalid_idempotency_key");
  });

  it("security headers from configureApp are present", async () => {
    const r = await h.http().get("/v1/cart").set(auth());
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["x-powered-by"]).toBeUndefined();
  });
});
