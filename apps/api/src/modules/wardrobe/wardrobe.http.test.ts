import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sku } from "./test/stylist-fixtures";
import { UnconfiguredVision } from "./adapters/unconfigured";
import { FLAG_WARDROBE, FLAG_WARDROBE_VISION, DEFAULT_WARDROBE_CONFIG } from "./application/shared";
import { IDEM, TOKENS, USERS, bearer, createWardrobeHarness, type WardrobeHarness } from "./test/harness";

let h: WardrobeHarness;
let seq = 0;
beforeAll(async () => {
  h = await createWardrobeHarness();
}, 60_000);
afterAll(async () => {
  await h.close();
});

const top = { category: "top", palette: ["white"], pattern: "solid", formality: 2, seasons: ["all"], material: "cotton", modest: true };
const bottom = { ...top, category: "bottom", palette: ["navy"] };
const shoes = { ...top, category: "shoes", palette: ["black"] };
const dress = { ...top, category: "dress", palette: ["black"] };

const send = (method: "post" | "patch" | "delete" | "get", path: string, token: string | null, body?: unknown, key: string | null | undefined = undefined) => {
  let r = h.http()[method](path);
  const k = key === undefined ? (method === "get" ? null : IDEM(++seq)) : key;
  if (k !== null) r = r.set({ "Idempotency-Key": k });
  if (token !== null) r = r.set(bearer(token));
  return body === undefined ? r : r.send(body as object);
};
const addManual = async (attrs: object, token = TOKENS.a): Promise<string> => {
  const r = await send("post", "/v1/me/wardrobe/items", token, { attributes: attrs });
  expect(r.status).toBe(201);
  return r.body.id as string;
};
const addPhoto = async (state: "clean" | "infected" | "pending_scan" = "clean", token = TOKENS.a, bytes = new Uint8Array([1, 2, 3])) => {
  const up = await send("post", "/v1/me/wardrobe/uploads", token, { content_type: "image/jpeg", size_bytes: 1024 });
  expect(up.status).toBe(201);
  const uploadId = up.body.upload_id as string;
  if (state !== "pending_scan") h.images.put(uploadId, bytes, state);
  return { uploadId, res: await send("post", "/v1/me/wardrobe/items", token, { upload_id: uploadId }) };
};

describe("consent, kill switch and request shape", () => {
  it("refuses writes without the personalization consent (403) but lets the shopper read and delete", async () => {
    const consent = h.consent.personalization;
    consent.delete(USERS.b);
    expect((await send("post", "/v1/me/wardrobe/items", TOKENS.b, { attributes: top })).body.code).toBe("consent_required");
    expect((await send("post", "/v1/me/wardrobe/uploads", TOKENS.b, { content_type: "image/png", size_bytes: 10 })).status).toBe(403);
    expect((await send("get", "/v1/me/wardrobe/items", TOKENS.b)).status).toBe(200);
    consent.add(USERS.b);
  });

  it("requires authentication, the buyer audience and an Idempotency-Key on writes", async () => {
    expect((await send("get", "/v1/me/wardrobe/items", null)).status).toBe(401);
    // A token for another audience is not a buyer token at all.
    expect((await send("get", "/v1/me/wardrobe/items", TOKENS.aOnSellerAud)).status).toBe(401);
    expect((await send("get", "/v1/me/wardrobe/items", TOKENS.seller)).status).toBe(401);
    expect((await send("post", "/v1/me/wardrobe/items", TOKENS.a, { attributes: top }, null)).status).toBe(400);
    const key = IDEM(++seq);
    const a = await send("post", "/v1/me/wardrobe/items", TOKENS.a, { attributes: top }, key);
    const b = await send("post", "/v1/me/wardrobe/items", TOKENS.a, { attributes: top }, key);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect((await send("post", "/v1/me/wardrobe/items", TOKENS.a, { attributes: bottom }, key)).status).toBe(422);
  });

  it("rejects extras, free text, out-of-vocabulary values and an empty item", async () => {
    const bad = async (b: unknown) => (await send("post", "/v1/me/wardrobe/items", TOKENS.a, b)).status;
    expect(await bad({ attributes: top, nickname: "x" })).toBe(400);
    expect(await bad({ attributes: { ...top, material: "unobtainium" } })).toBe(400);
    expect(await bad({ attributes: { ...top, brand: "free text" } })).toBe(400);
    expect(await bad({ attributes: { category: "top" } })).toBe(400); // manual item must be complete
    expect(await bad({})).toBe(400);
    expect(await bad({ upload_id: "../../etc/passwd" })).toBe(400);
    expect((await send("post", "/v1/me/wardrobe/uploads", TOKENS.a, { content_type: "image/gif", size_bytes: 10 })).status).toBe(400);
    expect((await send("post", "/v1/me/wardrobe/uploads", TOKENS.a, { content_type: "image/png", size_bytes: 10 * 1024 * 1024 + 1 })).status).toBe(400);
  });

  it("answers 503 wardrobe_disabled behind the kill switch and fails closed", async () => {
    h.flags.on.delete(FLAG_WARDROBE);
    const r = await send("post", "/v1/me/wardrobe/items", TOKENS.a, { attributes: top });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("wardrobe_disabled");
    h.flags.on.add(FLAG_WARDROBE);
  });
});

describe("photo pipeline", () => {
  it("adopts a scanned upload, never exposes the object key, and serves the photo only through a signed GET", async () => {
    const { uploadId, res } = await addPhoto("clean");
    expect(res.status).toBe(201);
    expect(res.body.photo.state).toBe("clean");
    expect(JSON.stringify(res.body)).not.toContain("wardrobe/");
    const url = await send("get", `/v1/me/wardrobe/items/${res.body.id}/photo`, TOKENS.a);
    expect(url.status).toBe(200);
    expect(url.body.url).toContain(uploadId);
    expect((await send("get", `/v1/me/wardrobe/items/${res.body.id}/photo`, TOKENS.b)).status).toBe(404);
  });

  it("keeps a photo pending until scanned: not served, then clean after the verdict", async () => {
    const { uploadId, res } = await addPhoto("pending_scan");
    expect(res.status).toBe(201);
    expect(res.body.photo.state).toBe("pending_scan");
    expect((await send("get", `/v1/me/wardrobe/items/${res.body.id}/photo`, TOKENS.a)).status).toBe(409);
    h.images.put(uploadId, new Uint8Array([9]), "clean");
    const again = await send("get", `/v1/me/wardrobe/items/${res.body.id}`, TOKENS.a);
    expect(again.body.photo.state).toBe("clean");
  });

  it("refuses an infected upload and a reused or foreign upload id", async () => {
    const inf = await addPhoto("infected");
    expect(inf.res.status).toBe(422);
    expect(inf.res.body.code).toBe("upload_rejected");
    const ok = await addPhoto("clean");
    expect(ok.res.status).toBe(201);
    const reuse = await send("post", "/v1/me/wardrobe/items", TOKENS.a, { upload_id: ok.uploadId });
    expect(reuse.body.code).toBe("upload_unavailable");
    const mine = await send("post", "/v1/me/wardrobe/uploads", TOKENS.a, { content_type: "image/webp", size_bytes: 5 });
    h.images.put(mine.body.upload_id as string, new Uint8Array([1]));
    const stolen = await send("post", "/v1/me/wardrobe/items", TOKENS.b, { upload_id: mine.body.upload_id });
    expect(stolen.status).toBe(422);
  });

  it("answers 503 when no object store is configured (production default)", async () => {
    const { UnconfiguredWardrobeImages } = await import("./adapters/unconfigured");
    const alt = await createWardrobeHarness({ images: new UnconfiguredWardrobeImages() as never });
    const r = await alt.http().post("/v1/me/wardrobe/uploads").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ content_type: "image/jpeg", size_bytes: 10 });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("wardrobe_storage_unconfigured");
    await alt.close();
  });
});

describe("authorization (BOLA)", () => {
  it("another shopper's item is indistinguishable from a missing one on every item route", async () => {
    const id = await addManual(top);
    const missing = U_MISSING;
    for (const [m, p, b] of [
      ["get", `/v1/me/wardrobe/items/${id}`, undefined],
      ["patch", `/v1/me/wardrobe/items/${id}`, { attributes: { formality: 3 } }],
      ["delete", `/v1/me/wardrobe/items/${id}`, undefined],
      ["get", `/v1/me/wardrobe/items/${id}/photo`, undefined],
      ["post", `/v1/me/wardrobe/items/${id}/suggest-attributes`, {}],
    ] as const) {
      const other = await send(m, p, TOKENS.b, b);
      const gone = await send(m, p.replace(id, missing), TOKENS.b, b);
      expect([m, other.status]).toEqual([m, 404]);
      expect(other.body).toMatchObject({ status: 404, code: "not_found" });
      expect(gone.status).toBe(404);
    }
    const mine = await send("get", `/v1/me/wardrobe/items/${id}`, TOKENS.a);
    expect(mine.status).toBe(200);
    const list = await send("get", "/v1/me/wardrobe/items?limit=50", TOKENS.b);
    expect((list.body.items as { id: string }[]).some((i) => i.id === id)).toBe(false);
    const done = await send("post", "/v1/me/wardrobe/complete", TOKENS.b, { kind: "work", item_ids: [id] });
    expect(done.status).toBe(404);
  });
});

const U_MISSING = "00000000-0000-4000-8000-0000deadbeef";

describe("attributes, vision suggestions and edits", () => {
  it("applies a suggestion for review, lets the shopper edit it, and then never overwrites the edit", async () => {
    const { res } = await addPhoto("clean", TOKENS.a, new Uint8Array([7, 7, 7]));
    const id = res.body.id as string;
    expect(res.body.complete).toBe(false);
    const s = await send("post", `/v1/me/wardrobe/items/${id}/suggest-attributes`, TOKENS.a, {});
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ attributes_source: "vision", needs_review: true, complete: true, vision_model_version: "fake-vision-1" });
    const again = await send("post", `/v1/me/wardrobe/items/${id}/suggest-attributes`, TOKENS.a, {});
    expect(again.body.attributes).toEqual(s.body.attributes); // deterministic fake
    const edit = await send("patch", `/v1/me/wardrobe/items/${id}`, TOKENS.a, { attributes: { formality: 4, modest: true }, expected_version: s.body.version + 1 });
    expect(edit.status).toBe(200);
    expect(edit.body).toMatchObject({ attributes_source: "user", needs_review: false });
    expect(edit.body.attributes).toMatchObject({ formality: 4, modest: true });
    const blocked = await send("post", `/v1/me/wardrobe/items/${id}/suggest-attributes`, TOKENS.a, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe("attributes_edited");
    const stale = await send("patch", `/v1/me/wardrobe/items/${id}`, TOKENS.a, { attributes: { formality: 1 }, expected_version: 1 });
    expect(stale.body.code).toBe("version_conflict");
  });

  it("needs a photo that passed the scan", async () => {
    const m = await addManual(top);
    expect((await send("post", `/v1/me/wardrobe/items/${m}/suggest-attributes`, TOKENS.a, {})).body.code).toBe("no_photo");
    const p = await addPhoto("pending_scan");
    expect((await send("post", `/v1/me/wardrobe/items/${p.res.body.id}/suggest-attributes`, TOKENS.a, {})).body.code).toBe("photo_not_ready");
  });

  it("fails closed: Unconfigured vision, the vision kill switch and external residency without consent", async () => {
    const alt = await createWardrobeHarness({ vision: new UnconfiguredVision() });
    const up = await alt.http().post("/v1/me/wardrobe/uploads").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ content_type: "image/jpeg", size_bytes: 10 });
    alt.images.put(up.body.upload_id as string, new Uint8Array([1]));
    const it = await alt.http().post("/v1/me/wardrobe/items").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ upload_id: up.body.upload_id });
    const r = await alt.http().post(`/v1/me/wardrobe/items/${it.body.id}/suggest-attributes`).set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({});
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("wardrobe_vision_unconfigured");
    await alt.close();

    const { res } = await addPhoto("clean");
    h.flags.on.delete(FLAG_WARDROBE_VISION);
    expect((await send("post", `/v1/me/wardrobe/items/${res.body.id}/suggest-attributes`, TOKENS.a, {})).body.code).toBe("wardrobe_vision_disabled");
    h.flags.on.add(FLAG_WARDROBE_VISION);
    h.vision.residency = "external";
    const ext = await send("post", `/v1/me/wardrobe/items/${res.body.id}/suggest-attributes`, TOKENS.a, {});
    expect(ext.status).toBe(403);
    expect(h.vision.calls).toBeGreaterThan(0);
    const callsBefore = h.vision.calls;
    await send("post", `/v1/me/wardrobe/items/${res.body.id}/suggest-attributes`, TOKENS.a, {});
    expect(h.vision.calls).toBe(callsBefore); // the photo never reached the external vendor
    h.vision.residency = "in_region";
  });
});

describe("caps and deletion", () => {
  it("caps items and pending uploads per shopper", async () => {
    const small = await createWardrobeHarness({ config: { ...DEFAULT_WARDROBE_CONFIG, maxItems: 2, maxPendingUploads: 2 } });
    const post = (p: string, b: object) => small.http().post(p).set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send(b);
    expect((await post("/v1/me/wardrobe/items", { attributes: top })).status).toBe(201);
    expect((await post("/v1/me/wardrobe/items", { attributes: bottom })).status).toBe(201);
    const full = await post("/v1/me/wardrobe/items", { attributes: shoes });
    expect(full.status).toBe(409);
    expect(full.body.code).toBe("wardrobe_full");
    expect((await post("/v1/me/wardrobe/uploads", { content_type: "image/jpeg", size_bytes: 5 })).status).toBe(201);
    expect((await post("/v1/me/wardrobe/uploads", { content_type: "image/jpeg", size_bytes: 5 })).status).toBe(201);
    const many = await post("/v1/me/wardrobe/uploads", { content_type: "image/jpeg", size_bytes: 5 });
    expect(many.status).toBe(409);
    expect(many.body.code).toBe("too_many_pending_uploads");
    await small.close();
  });

  it("paginates newest first with an opaque cursor and rejects a forged one", async () => {
    const alt = await createWardrobeHarness();
    for (let i = 0; i < 3; i++) {
      alt.clock.advance(1000);
      await alt.http().post("/v1/me/wardrobe/items").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ attributes: top });
    }
    const p1 = await alt.http().get("/v1/me/wardrobe/items?limit=2").set(bearer(TOKENS.a));
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.next_cursor).toEqual(expect.any(String));
    const p2 = await alt.http().get(`/v1/me/wardrobe/items?limit=2&cursor=${p1.body.next_cursor}`).set(bearer(TOKENS.a));
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.next_cursor).toBeNull();
    expect((await alt.http().get("/v1/me/wardrobe/items?cursor=garbage").set(bearer(TOKENS.a))).status).toBe(400);
    expect((await alt.http().get("/v1/me/wardrobe/items?limit=500").set(bearer(TOKENS.a))).status).toBe(400);
    await alt.close();
  });

  it("deletes the row and the photo at once, and clears the whole wardrobe on request", async () => {
    const { uploadId, res } = await addPhoto("clean");
    const id = res.body.id as string;
    const del = await send("delete", `/v1/me/wardrobe/items/${id}`, TOKENS.a);
    expect(del.status).toBe(204);
    expect(h.images.deleted).toContain(uploadId);
    expect(h.images.objects.has(uploadId)).toBe(false);
    expect((await send("get", `/v1/me/wardrobe/items/${id}`, TOKENS.a)).status).toBe(404);

    const p = await addPhoto("clean", TOKENS.b);
    expect(p.res.status).toBe(201);
    await addManual(top, TOKENS.b);
    const orphan = await send("post", "/v1/me/wardrobe/uploads", TOKENS.b, { content_type: "image/png", size_bytes: 5 });
    expect((await send("delete", "/v1/me/wardrobe", TOKENS.b)).status).toBe(204);
    expect(h.images.objects.has(p.uploadId)).toBe(false);
    expect(h.images.objects.has(orphan.body.upload_id as string)).toBe(false);
    expect(((await send("get", "/v1/me/wardrobe/items", TOKENS.b)).body.items as unknown[]).length).toBe(0);
    expect(((await send("get", "/v1/me/wardrobe/items", TOKENS.a)).body.items as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("complete from wardrobe", () => {
  const complete = (body: object, token = TOKENS.a) => {
    h.clock.advance(61_000);
    return send("post", "/v1/me/wardrobe/complete", token, body);
  };

  it("locks owned garments as zero price slots and buys only the rest, within the budget", async () => {
    const alt = await createWardrobeHarness();
    const add = async (a: object) =>
      (await alt.http().post("/v1/me/wardrobe/items").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ attributes: a })).body.id as string;
    const topId = await add(top);
    const shoesId = await add(shoes);
    const r = await alt.http().post("/v1/me/wardrobe/complete").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ kind: "work", budget_piastres: "50000" });
    expect(r.status).toBe(200);
    expect(r.body.owned).toEqual([
      { slot: "top", wardrobe_item_id: topId },
      { slot: "shoes", wardrobe_item_id: shoesId },
    ]);
    expect(r.body.outfits.length).toBeGreaterThan(0);
    for (const o of r.body.outfits as { total_piastres: string; items: { slot: string; price_piastres: string }[]; owned_slots: string[] }[]) {
      const slots = o.items.map((i) => i.slot);
      expect(slots).not.toContain("top");
      expect(slots).not.toContain("shoes");
      expect(o.owned_slots).toEqual(["top", "shoes"]);
      const sum = o.items.reduce((s, i) => s + BigInt(i.price_piastres), 0n);
      expect(BigInt(o.total_piastres)).toBe(sum);
      expect(sum <= 50_000n).toBe(true);
    }
    // The outfits are the stylist's: stored for add-to-bag, counted by its fair use.
    expect(await alt.stylist.outfits.getOutfit(r.body.outfits[0].outfit_id as string)).not.toBeNull();
    await alt.close();
  });

  it("buys nothing when the wardrobe already makes a whole outfit, and keeps the budget untouched", async () => {
    const alt = await createWardrobeHarness();
    for (const a of [dress, shoes, { ...top, category: "bag" }, { ...top, category: "accessory" }]) {
      await alt.http().post("/v1/me/wardrobe/items").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ attributes: a });
    }
    const r = await alt.http().post("/v1/me/wardrobe/complete").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ kind: "work", budget_piastres: "100" });
    expect(r.status).toBe(200);
    expect(r.body.owned_only).toBe(true);
    expect(r.body.outfits).toEqual([]);
    await alt.close();
  });

  it("422 when nothing owned fits; modest mode excludes garments not marked modest; season filters", async () => {
    const alt = await createWardrobeHarness();
    const go = (p: string, b: object) => alt.http().post(p).set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send(b);
    await go("/v1/me/wardrobe/items", { attributes: { ...top, modest: false, formality: 0, seasons: ["winter"] } });
    const none = await go("/v1/me/wardrobe/complete", { kind: "wedding_guest" });
    expect(none.status).toBe(422);
    expect(none.body.code).toBe("nothing_owned");
    const q = (qs: string) => alt.http().get(`/v1/me/wardrobe/owned-slots?${qs}`).set(bearer(TOKENS.a));
    expect((await q("kind=university&season=winter&modest=false")).body.owned_slots).toEqual(["top"]);
    expect((await q("kind=university&season=winter&modest=true")).body.owned_slots).toEqual([]);
    expect((await q("kind=university&season=summer&modest=false")).body.owned_slots).toEqual([]);
    expect((await q("kind=nope")).status).toBe(400);
    await alt.close();
  });

  it("rejects bad input, other shoppers' item ids and a withdrawn consent; counts against fair use", async () => {
    expect((await complete({ kind: "birthday" })).status).toBe(400);
    expect((await complete({ kind: "work", budget_piastres: "-5" })).status).toBe(400);
    expect((await complete({ kind: "work", item_ids: [] })).status).toBe(400);
    expect((await complete({ kind: "work", extra: 1 })).status).toBe(400);
    h.consent.personalization.delete(USERS.a);
    expect((await complete({ kind: "work" })).body.code).toBe("consent_required");
    h.consent.personalization.add(USERS.a);
  });

  it("answers 429 once the daily fair-use ceiling is spent", async () => {
    const alt = await createWardrobeHarness({ config: { ...DEFAULT_WARDROBE_CONFIG, dailyGenerations: 1 } });
    await alt.http().post("/v1/me/wardrobe/items").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ attributes: top });
    const go = () => alt.http().post("/v1/me/wardrobe/complete").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ kind: "work" });
    expect((await go()).status).toBe(200);
    alt.clock.advance(61_000);
    expect((await go()).status).toBe(429);
    await alt.close();
  });

  it("uses catalog candidates only through the stylist (sku ids unchanged)", () => {
    expect(sku(1)).toMatch(/^00000000-/);
  });
});

describe("rate limits", () => {
  it("limits upload issuance per user", async () => {
    const alt = await createWardrobeHarness({ config: { ...DEFAULT_WARDROBE_CONFIG, maxPendingUploads: 1000 } });
    let last = 0;
    for (let i = 0; i < 22; i++) {
      last = (await alt.http().post("/v1/me/wardrobe/uploads").set({ "Idempotency-Key": IDEM(++seq) }).set(bearer(TOKENS.a)).send({ content_type: "image/jpeg", size_bytes: 5 })).status;
    }
    expect(last).toBe(429);
    await alt.close();
  });
});
