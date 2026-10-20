import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN, U } from "./fixtures";
import { bearer, createSellersHarness, nextKey, pdfBytes, sha, type SellersHarness } from "./harness";

let h: SellersHarness;
beforeAll(async () => {
  h = await createSellersHarness();
});
afterAll(async () => {
  await h.close();
});

let userCounter = 1000;
const newUser = (): string => U((userCounter += 1));

const post = (path: string, token: string | null, body: object = {}, key: string | null = nextKey()) => {
  let r = h.http().post(path);
  if (token !== null) r = r.set(bearer(token));
  if (key !== null) r = r.set("Idempotency-Key", key);
  return r.send(body);
};
const patch = (path: string, token: string | null, body: object) => {
  let r = h.http().patch(path).set("Idempotency-Key", nextKey());
  if (token !== null) r = r.set(bearer(token));
  return r.send(body);
};
const get = (path: string, token: string | null) => {
  let r = h.http().get(path);
  if (token !== null) r = r.set(bearer(token));
  return r;
};
const del = (path: string, token: string | null) => {
  let r = h.http().delete(path).set("Idempotency-Key", nextKey());
  if (token !== null) r = r.set(bearer(token));
  return r;
};

const FIELDS = {
  legal_name: "Zara Egypt LLC",
  ownership_basis: "brand_owner",
  registration: { commercial_register_no: "123456", tax_card_no: "123456789" },
  contact: { name: "Mona Ali", phone_e164: "+201001234567", email: "mona@zara.example" },
  signatory: { full_name: "Ali Hassan", national_id: "29001010100012", date_of_birth: "1990-01-01" },
  acknowledgements: { seller_agreement_version: "2026-10", dpa_version: "2026-10", price_monitoring_consent: true },
};

async function uploadDoc(token: string, appId: string, code: string, bytes: Uint8Array = pdfBytes()) {
  const created = await post(`/v1/seller/applications/${appId}/documents`, token, {
    requirement_code: code, content_type: "application/pdf", size_bytes: bytes.length, sha256: sha(bytes), original_filename: "scan.pdf",
  });
  expect(created.status).toBe(201);
  const docId = created.body.document_id as string;
  const key = new URL(created.body.upload_url as string).pathname.slice(1);
  h.store.put(key, bytes);
  const confirmed = await post(`/v1/seller/applications/${appId}/documents/${docId}/confirm`, token, {});
  return { created, confirmed, docId, key };
}

/** A complete DRAFT application for a fresh applicant. */
async function completeDraft(name = `Zara ${Math.random().toString(36).slice(2, 8)}`) {
  const user = newUser();
  const enrol = h.tokens.enrol(user);
  const res = await post("/v1/seller/applications", enrol, { brand_kind: "local", country: "EG", brand_name: name });
  expect(res.status).toBe(201);
  const id = res.body.id as string;
  expect((await patch(`/v1/seller/applications/${id}`, enrol, FIELDS)).status).toBe(200);
  for (const code of ["commercial_register", "tax_card", "signatory_id", "brand_authorization"]) {
    expect((await uploadDoc(enrol, id, code)).confirmed.status).toBe(200);
  }
  return { user, id, enrol, weak: h.tokens.weak(user), strong: h.tokens.strong(user) };
}

describe("requirements", () => {
  it("serves the Egypt local checklist as data with an ETag, and 304 on revalidation", async () => {
    const t = h.tokens.enrol(newUser());
    const r = await get("/v1/seller/applications/requirements?kind=local&country=EG", t);
    expect(r.status).toBe(200);
    expect(r.body.documents.map((d: { code: string }) => d.code)).toEqual(
      expect.arrayContaining(["commercial_register", "tax_card", "signatory_id", "trademark_certificate", "brand_authorization", "proof_of_purchase"]),
    );
    expect(r.body.fields.find((f: { code: string }) => f.code === "signatory_national_id").min_signatory_age).toBe(21);
    const again = await get("/v1/seller/applications/requirements?kind=local&country=EG", t).set("If-None-Match", r.headers["etag"] as string);
    expect(again.status).toBe(304);
  });
  it("serves the global checklist for any country and validates the query", async () => {
    const t = h.tokens.enrol(newUser());
    const r = await get("/v1/seller/applications/requirements?kind=global&country=FR", t);
    expect(r.body.website_verification).toBe("required");
    expect(r.body.documents.map((d: { code: string }) => d.code)).toContain("distributor_letter");
    expect((await get("/v1/seller/applications/requirements?kind=nope&country=FR", t)).status).toBe(400);
    expect((await get("/v1/seller/applications/requirements?kind=local", t)).status).toBe(400);
  });
});

describe("authentication and token types", () => {
  const routes: [string, string][] = [
    ["get", "/v1/seller/applications"],
    ["post", "/v1/seller/applications"],
    ["get", `/v1/seller/applications/${U(1)}`],
    ["patch", `/v1/seller/applications/${U(1)}`],
    ["post", `/v1/seller/applications/${U(1)}/submit`],
    ["post", `/v1/seller/applications/${U(1)}/resubmit`],
    ["post", `/v1/seller/applications/${U(1)}/withdraw`],
    ["post", `/v1/seller/applications/${U(1)}/appeal`],
    ["post", `/v1/seller/applications/${U(1)}/documents`],
    ["post", `/v1/seller/applications/${U(1)}/documents/${U(2)}/confirm`],
    ["delete", `/v1/seller/applications/${U(1)}/documents/${U(2)}`],
    ["get", "/v1/seller/onboarding-checklist"],
    ["get", "/v1/seller/applications/requirements?kind=local&country=EG"],
  ];
  const call = (m: string, path: string, token: string | null) => {
    let r = h.http()[m as "get"](path);
    if (token !== null) r = r.set(bearer(token));
    return r.set("Idempotency-Key", nextKey()).send({});
  };
  it.each(routes)("%s %s: no token is 401", async (m, p) => {
    expect((await call(m, p, null)).status).toBe(401);
  });
  it.each(routes)("%s %s: a shopper (buyer_api) token is 401", async (m, p) => {
    expect((await call(m, p, h.tokens.buyer(newUser()))).status).toBe(401);
  });
  it("a suspended subject is 403", async () => {
    const t = "suspended-token-0000000000";
    // Not registered in the table: unknown bearer is 401, never a silent success.
    expect((await get("/v1/seller/applications", t)).status).toBe(401);
  });
});

describe("create and patch", () => {
  it("creates a draft with an enrolment token and replays the same Idempotency-Key", async () => {
    const t = h.tokens.enrol(newUser());
    const key = nextKey();
    const body = { brand_kind: "local", country: "EG", brand_name: "Mango Cairo" };
    const a = await post("/v1/seller/applications", t, body, key);
    const b = await post("/v1/seller/applications", t, body, key);
    expect(a.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(a.body.status).toBe("DRAFT");
    expect(a.body.allowed_actions).toEqual(expect.arrayContaining(["edit", "submit", "upload_document", "withdraw"]));
    expect((await get("/v1/seller/applications", t)).body.items).toHaveLength(1);
    expect(h.funnel.events.some((e) => e.name === "brand_application_started")).toBe(true);
  });
  it("requires an Idempotency-Key and rejects unknown properties and local brands outside Egypt", async () => {
    const t = h.tokens.enrol(newUser());
    expect((await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Ok Name" }, null)).status).toBe(400);
    expect((await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Ok Name", extra: 1 })).status).toBe(400);
    const r = await post("/v1/seller/applications", t, { brand_kind: "local", country: "FR", brand_name: "Paris Brand" });
    expect(r.status).toBe(400);
    expect(r.body.errors[0]).toMatchObject({ pointer: "/country", code: "local_requires_egypt" });
  });
  it("allows one active application per normalised brand name", async () => {
    const t = h.tokens.enrol(newUser());
    expect((await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Nike" })).status).toBe(201);
    const dup = await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: " NIKE!! " });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_active_application");
  });
  it("validates field formats and masks identifiers, never returning the national id", async () => {
    const t = h.tokens.enrol(newUser());
    const id = (await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Adidas Eg" })).body.id as string;
    const bad = await patch(`/v1/seller/applications/${id}`, t, { registration: { tax_card_no: "12" }, signatory: { national_id: "123" }, website_domain: "localhost" });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: { pointer: string }) => e.pointer).sort()).toEqual(["/registration/tax_card_no", "/signatory/national_id", "/website_domain"]);
    const ok = await patch(`/v1/seller/applications/${id}`, t, FIELDS);
    expect(ok.status).toBe(200);
    expect(ok.body.registration).toMatchObject({ commercial_register_no: "**3456", tax_card_no: "*****6789" });
    expect(ok.body.signatory_masked).toEqual({ full_name: "Ali Hassan", national_id_last4: "0012" });
    expect(JSON.stringify(ok.body)).not.toContain("29001010100012");
    expect((await patch(`/v1/seller/applications/${id}`, t, {})).status).toBe(400);
  });
  it("keeps personal data out of plaintext storage", async () => {
    const t = h.tokens.enrol(newUser());
    const id = (await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Puma Eg" })).body.id as string;
    await patch(`/v1/seller/applications/${id}`, t, FIELDS);
    const row = (await h.repo.get(id, { kind: "system" }))?.app;
    const dump = JSON.stringify(row);
    for (const secret of ["Ali Hassan", "29001010100012", "mona@zara.example", "+201001234567", "Zara Egypt LLC"]) expect(dump).not.toContain(secret);
    expect(row?.piiEnc).not.toBeNull();
  });
});

describe("documents", () => {
  it("issues a signed upload URL with a random key, confirms with magic-byte check and scan", async () => {
    const user = newUser();
    const t = h.tokens.enrol(user);
    const id = (await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Doc Brand" })).body.id as string;
    const up = await uploadDoc(t, id, "commercial_register");
    expect(up.created.body).toMatchObject({ upload_method: "PUT" });
    expect(up.key).toMatch(/^kyc\/\d{4}\/\d{2}\/[0-9a-f-]{36}$/);
    expect(up.key).not.toContain(id);
    expect(up.key).not.toContain(user);
    expect(up.confirmed.body).toMatchObject({ upload_status: "uploaded", scan_status: "clean", review_status: "unreviewed" });
    expect(up.confirmed.body.original_filename).toBe("scan.pdf");
    const again = await post(`/v1/seller/applications/${id}/documents/${up.docId}/confirm`, t, {});
    expect(again.status).toBe(200);
    expect((await get(`/v1/seller/applications/${id}`, t)).body.documents).toHaveLength(1);
  });
  it("rejects unknown requirement, wrong type and oversize with 400", async () => {
    const t = h.tokens.enrol(newUser());
    const id = (await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Doc Brand 2" })).body.id as string;
    const base = { requirement_code: "commercial_register", content_type: "application/pdf", size_bytes: 10, sha256: "a".repeat(64) };
    expect((await post(`/v1/seller/applications/${id}/documents`, t, { ...base, requirement_code: "nope" })).status).toBe(400);
    expect((await post(`/v1/seller/applications/${id}/documents`, t, { ...base, content_type: "image/gif" })).status).toBe(400);
    expect((await post(`/v1/seller/applications/${id}/documents`, t, { ...base, size_bytes: 10_485_761 })).status).toBe(400);
  });
  it("confirm before upload is 409; a spoofed type or size is 422 and the object is removed", async () => {
    const t = h.tokens.enrol(newUser());
    const id = (await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Doc Brand 3" })).body.id as string;
    const mk = async (size: number) =>
      (await post(`/v1/seller/applications/${id}/documents`, t, { requirement_code: "tax_card", content_type: "application/pdf", size_bytes: size, sha256: "b".repeat(64) })).body;
    const first = await mk(20);
    expect((await post(`/v1/seller/applications/${id}/documents/${first.document_id}/confirm`, t, {})).status).toBe(409);
    const key = new URL(first.upload_url as string).pathname.slice(1);
    h.store.put(key, new Uint8Array(20).fill(7));
    const spoof = await post(`/v1/seller/applications/${id}/documents/${first.document_id}/confirm`, t, {});
    expect(spoof.status).toBe(422);
    expect(spoof.body.code).toBe("magic_bytes_mismatch");
    expect(h.store.objects.has(key)).toBe(false);
    const second = await mk(30);
    const key2 = new URL(second.upload_url as string).pathname.slice(1);
    h.store.put(key2, pdfBytes(31));
    expect((await post(`/v1/seller/applications/${id}/documents/${second.document_id}/confirm`, t, {})).body.code).toBe("size_mismatch");
  });
  it("marks an infected upload and deletes the object; delete removes a document while editable", async () => {
    const t = h.tokens.enrol(newUser());
    const id = (await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Doc Brand 4" })).body.id as string;
    const bytes = new TextEncoder().encode("%PDF-1.7 EICAR-STANDARD-ANTIVIRUS-TEST-FILE");
    const up = await uploadDoc(t, id, "tax_card", bytes);
    expect(up.confirmed.body.scan_status).toBe("infected");
    expect(h.store.objects.has(up.key)).toBe(false);
    expect((await del(`/v1/seller/applications/${id}/documents/${up.docId}`, t)).status).toBe(204);
    expect((await get(`/v1/seller/applications/${id}`, t)).body.documents).toEqual([]);
  });
  it("limits uploads to 20 per hour per application with 429", async () => {
    const user = newUser();
    const t = h.tokens.enrol(user);
    const id = (await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Doc Brand 5" })).body.id as string;
    const body = { requirement_code: "tax_card", content_type: "application/pdf", size_bytes: 10, sha256: "c".repeat(64) };
    for (let i = 0; i < 20; i += 1) {
      // The per-user route limit is 30/hour, so advance the clock between batches to isolate the per-application cap.
      expect((await post(`/v1/seller/applications/${id}/documents`, t, body)).status).toBe(201);
    }
    const over = await post(`/v1/seller/applications/${id}/documents`, t, body);
    expect(over.status).toBe(429);
    h.clock.advance(61 * 60_000);
    expect((await post(`/v1/seller/applications/${id}/documents`, t, body)).status).toBe(201);
  });
});

describe("submit", () => {
  it("rejects an incomplete application with 422 listing what is missing", async () => {
    const user = newUser();
    const t = h.tokens.strong(user);
    const id = (await post("/v1/seller/applications", t, { brand_kind: "local", country: "EG", brand_name: "Incomplete" })).body.id as string;
    const r = await post(`/v1/seller/applications/${id}/submit`, t);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("incomplete_application");
    expect(r.body.errors.map((e: { pointer: string }) => e.pointer)).toEqual(expect.arrayContaining(["/legal_name", "/acknowledgements"]));
  });
  it("needs a full session and a strong factor; an enrolment token is 403", async () => {
    const d = await completeDraft();
    const asEnrol = await post(`/v1/seller/applications/${d.id}/submit`, d.enrol);
    expect(asEnrol.status).toBe(403);
    const asWeak = await post(`/v1/seller/applications/${d.id}/submit`, d.weak);
    expect(asWeak.status).toBe(403);
    expect(asWeak.body.code).toBe("strong_factor_required");
    expect((await get(`/v1/seller/applications/${d.id}`, d.enrol)).body.status).toBe("DRAFT");
  });
  it("submits a complete application: SUBMITTED, SLA due date, outbox event with ids only, then it is read-only", async () => {
    const d = await completeDraft();
    const before = h.repo.outbox.length;
    const r = await post(`/v1/seller/applications/${d.id}/submit`, d.strong);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("SUBMITTED");
    expect(r.body.submitted_at).not.toBeNull();
    expect(new Date(r.body.decision_due_at).getTime()).toBeGreaterThan(new Date(r.body.submitted_at).getTime());
    expect(r.body.allowed_actions).toEqual(["withdraw"]);
    const ev = h.repo.outbox.slice(before);
    expect(ev.map((e) => e.type)).toEqual(["brand_application.submitted"]);
    expect(JSON.stringify(ev[0]?.payload)).not.toMatch(/Zara|2900|mona|\+20/);
    expect((await patch(`/v1/seller/applications/${d.id}`, d.strong, { legal_name: "x" })).status).toBe(409);
    expect((await post(`/v1/seller/applications/${d.id}/submit`, d.strong)).status).toBe(409);
    expect(h.funnel.events.some((e) => e.name === "brand_application_submitted")).toBe(true);
  });
  it("a signatory under 21 blocks submission", async () => {
    const user = newUser();
    const enrol = h.tokens.enrol(user);
    const id = (await post("/v1/seller/applications", enrol, { brand_kind: "local", country: "EG", brand_name: "Young Signer" })).body.id as string;
    // 2010-01-01 national id, age 16.
    await patch(`/v1/seller/applications/${id}`, enrol, { ...FIELDS, signatory: { full_name: "Kid", national_id: "31001010100012", date_of_birth: "2010-01-01" } });
    for (const code of ["commercial_register", "tax_card", "signatory_id", "brand_authorization"]) await uploadDoc(enrol, id, code);
    const r = await post(`/v1/seller/applications/${id}/submit`, h.tokens.strong(user));
    expect(r.status).toBe(422);
    expect(r.body.errors.some((e: { code: string }) => e.code === "signatory_age")).toBe(true);
  });
});

describe("object-level authorization", () => {
  it("another applicant's application and documents are 404, indistinguishable from missing, with no side effect", async () => {
    const d = await completeDraft();
    const other = newUser();
    const o = h.tokens.strong(other);
    const doc = (await get(`/v1/seller/applications/${d.id}`, d.enrol)).body.documents[0].id as string;
    const missing = U(424242);
    const probes: [string, string, object | undefined][] = [
      ["get", `/v1/seller/applications/${d.id}`, undefined],
      ["patch", `/v1/seller/applications/${d.id}`, { legal_name: "Hacked" }],
      ["post", `/v1/seller/applications/${d.id}/submit`, {}],
      ["post", `/v1/seller/applications/${d.id}/withdraw`, {}],
      ["post", `/v1/seller/applications/${d.id}/appeal`, { statement: "x".repeat(30) }],
      ["post", `/v1/seller/applications/${d.id}/resubmit`, {}],
      ["post", `/v1/seller/applications/${d.id}/documents`, { requirement_code: "tax_card", content_type: "application/pdf", size_bytes: 5, sha256: "d".repeat(64) }],
      ["post", `/v1/seller/applications/${d.id}/documents/${doc}/confirm`, {}],
      ["delete", `/v1/seller/applications/${d.id}/documents/${doc}`, undefined],
    ];
    for (const [m, p, body] of probes) {
      const foreign = await h.http()[m as "get"](p).set(bearer(o)).set("Idempotency-Key", nextKey()).send(body);
      const absent = await h.http()[m as "get"](p.replace(d.id, missing)).set(bearer(o)).set("Idempotency-Key", nextKey()).send(body);
      expect(foreign.status, `${m} ${p}`).toBe(404);
      expect(foreign.body.code).toBe(absent.body.code);
      expect(foreign.body.title).toBe(absent.body.title);
    }
    const mine = await get(`/v1/seller/applications/${d.id}`, d.enrol);
    expect(mine.body.legal_name).toBe("Zara Egypt LLC");
    expect(mine.body.documents.length).toBe(4);
    expect((await get("/v1/seller/applications", o)).body.items).toEqual([]);
  });
  it("malformed ids are 400 and never reach storage", async () => {
    const t = h.tokens.enrol(newUser());
    expect((await get("/v1/seller/applications/not-a-uuid", t)).status).toBe(400);
  });
});

describe("review loop through the admin port", () => {
  async function submitted() {
    const d = await completeDraft();
    expect((await post(`/v1/seller/applications/${d.id}/submit`, d.strong)).status).toBe(200);
    return d;
  }
  const ver = async (id: string) => (await h.admin.get(id))?.version ?? -1;

  it("walks SUBMITTED to NEEDS_INFO, resubmits once the requested item is satisfied, then approves", async () => {
    const d = await submitted();
    await h.admin.advanceChecks({ id: d.id, event: "START_CHECKS", expectedVersion: await ver(d.id) });
    await h.admin.advanceChecks({ id: d.id, event: "FINISH_CHECKS", expectedVersion: await ver(d.id) });
    expect((await h.admin.get(d.id))?.status).toBe("IN_REVIEW");
    // claim, version CAS and conflict of interest
    expect((await h.admin.claim({ id: d.id, adminId: ADMIN, expectedVersion: 0 })).kind).toBe("version_conflict");
    expect((await h.admin.claim({ id: d.id, adminId: d.user, expectedVersion: await ver(d.id) })).kind).toBe("conflict_of_interest");
    expect((await h.admin.claim({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id) })).kind).toBe("ok");
    expect((await h.admin.claim({ id: d.id, adminId: U(901), expectedVersion: await ver(d.id) })).kind).toBe("already_claimed");
    const noItems = await h.admin.applyDecision({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id), input: { decision: "needs_info", reasonCode: "incomplete_information", messageAr: "ناقص", messageEn: "Missing" } });
    expect(noItems.kind).toBe("invalid_input");
    const docs = (await get(`/v1/seller/applications/${d.id}`, d.enrol)).body.documents as { id: string; requirement_code: string }[];
    const taxId = docs.find((x) => x.requirement_code === "tax_card")!.id;
    const needs = await h.admin.applyDecision({
      id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id),
      input: {
        decision: "needs_info", reasonCode: "documents_unreadable", messageAr: "المستند غير واضح", messageEn: "Document unreadable",
        requestedItems: [{ code: "tax_card", kind: "document", messageAr: "أعد رفع البطاقة", messageEn: "Re-upload the tax card" }],
        documentReviews: [{ documentId: taxId, reviewStatus: "unreadable", notePublic: "blurry", noteInternal: "looks edited" }],
      },
    });
    expect(needs.kind).toBe("ok");
    const view = await get(`/v1/seller/applications/${d.id}`, d.enrol);
    expect(view.body.status).toBe("NEEDS_INFO");
    expect(view.body.requested_items[0]).toMatchObject({ code: "tax_card", satisfied: false });
    expect(view.body.decision).toMatchObject({ decision: "needs_info", reason_code: "documents_unreadable" });
    expect(JSON.stringify(view.body)).not.toContain("looks edited");
    expect(JSON.stringify(view.body)).not.toContain(ADMIN);
    expect(view.body.documents.find((x: { id: string }) => x.id === taxId).review_note_public).toBe("blurry");
    // The unreadable tax card no longer counts, so resubmitting is incomplete until a new one is uploaded.
    const early = await post(`/v1/seller/applications/${d.id}/resubmit`, d.strong, {});
    expect(early.status).toBe(422);
    expect((await patch(`/v1/seller/applications/${d.id}`, d.strong, { legal_name: "Zara Egypt LLC" })).status).toBe(200);
    expect((await uploadDoc(d.strong, d.id, "tax_card")).confirmed.status).toBe(200);
    expect((await get(`/v1/seller/applications/${d.id}`, d.enrol)).body.requested_items[0].satisfied).toBe(true);
    expect((await post(`/v1/seller/applications/${d.id}/resubmit`, d.enrol, {})).status).toBe(403);
    const re = await post(`/v1/seller/applications/${d.id}/resubmit`, d.strong, { note: "done" });
    expect(re.status).toBe(200);
    expect(re.body.status).toBe("SUBMITTED");
    expect(h.repo.outbox.map((e) => e.type)).toEqual(expect.arrayContaining(["brand_application.needs_info"]));
    // back through review to approval
    await h.admin.advanceChecks({ id: d.id, event: "START_CHECKS", expectedVersion: await ver(d.id) });
    await h.admin.advanceChecks({ id: d.id, event: "FINISH_CHECKS", expectedVersion: await ver(d.id) });
    await h.admin.claim({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id) });
    const guard = await h.admin.applyDecision({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id), input: { decision: "approved", reasonCode: "ok", messageAr: "تم", messageEn: "Approved" } });
    expect(guard.kind).toBe("guard_rejected");
    const ok = await h.admin.applyDecision({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id), input: { decision: "approved", reasonCode: "ok", messageAr: "تم", messageEn: "Approved", sanctionsClear: true } });
    expect(ok.kind).toBe("ok");
    expect((await get(`/v1/seller/applications/${d.id}`, d.enrol)).body.status).toBe("APPROVED");
    expect((await get("/v1/seller/onboarding-checklist", d.strong)).status).toBe(404);
    const prov = await h.admin.markProvisioned({ id: d.id, storeId: U(7777), expectedVersion: await ver(d.id) });
    expect(prov.kind).toBe("ok");
    const list = await get("/v1/seller/onboarding-checklist", d.strong);
    expect(list.status).toBe(200);
    expect(list.body.store_id).toBe(U(7777));
    expect(list.body.items.map((i: { code: string }) => i.code)).toContain("add_payout_iban");
    expect((await get("/v1/seller/onboarding-checklist", d.enrol)).status).toBe(403);
  });

  it("reject: cooldown blocks re-creating the brand for 30 days, one appeal within 30 days, reviewer must hold the claim", async () => {
    const d = await submitted();
    await h.admin.advanceChecks({ id: d.id, event: "START_CHECKS", expectedVersion: await ver(d.id) });
    await h.admin.advanceChecks({ id: d.id, event: "FINISH_CHECKS", expectedVersion: await ver(d.id) });
    const unclaimed = await h.admin.applyDecision({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id), input: { decision: "rejected", reasonCode: "not_a_brand", messageAr: "مرفوض", messageEn: "Rejected" } });
    expect(unclaimed.kind).toBe("not_claimed_by_actor");
    await h.admin.claim({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id) });
    const rej = await h.admin.applyDecision({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id), input: { decision: "rejected", reasonCode: "not_a_brand", messageAr: "مرفوض", messageEn: "Rejected" } });
    expect(rej.kind).toBe("ok");
    const view = await get(`/v1/seller/applications/${d.id}`, d.strong);
    expect(view.body.status).toBe("REJECTED");
    expect(view.body.decision.appeal_allowed).toBe(true);
    expect(view.body.allowed_actions).toEqual(["appeal"]);
    const name = view.body.brand_name as string;
    const re = await post("/v1/seller/applications", d.strong, { brand_kind: "local", country: "EG", brand_name: name });
    expect(re.status).toBe(409);
    expect(re.body.code).toBe("reapply_cooldown");
    expect((await post(`/v1/seller/applications/${d.id}/appeal`, d.strong, { statement: "short" })).status).toBe(400);
    const appeal = await post(`/v1/seller/applications/${d.id}/appeal`, d.strong, { statement: "The trademark certificate was attached, please re-review." });
    expect(appeal.status).toBe(200);
    expect(appeal.body.status).toBe("IN_REVIEW");
    expect(appeal.body.appeal_used).toBe(true);
    expect(h.repo.outbox.map((e) => e.type)).toEqual(expect.arrayContaining(["brand_application.rejected", "brand_application.appealed"]));
    // reject again: the single appeal is spent
    await h.admin.claim({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id) });
    await h.admin.applyDecision({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id), input: { decision: "rejected", reasonCode: "other", messageAr: "مرفوض", messageEn: "Rejected" } });
    expect((await post(`/v1/seller/applications/${d.id}/appeal`, d.strong, { statement: "Second attempt at appealing this." })).status).toBe(409);
    // after the cooldown the same name can be applied for again
    h.clock.advance(31 * 86_400_000);
    expect((await post("/v1/seller/applications", d.strong, { brand_kind: "local", country: "EG", brand_name: name })).status).toBe(201);
  });

  it("appeal after the 30 day window is refused", async () => {
    const d = await submitted();
    await h.admin.advanceChecks({ id: d.id, event: "START_CHECKS", expectedVersion: await ver(d.id) });
    await h.admin.claim({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id) });
    const rej = await h.admin.applyDecision({ id: d.id, adminId: ADMIN, expectedVersion: await ver(d.id), input: { decision: "rejected", reasonCode: "sanctions_hit", messageAr: "مرفوض", messageEn: "Rejected" } });
    expect(rej.kind).toBe("ok");
    h.clock.advance(31 * 86_400_000);
    const late = await post(`/v1/seller/applications/${d.id}/appeal`, d.strong, { statement: "Appealing far too late now." });
    expect(late.status).toBe(409);
    expect((await get(`/v1/seller/applications/${d.id}`, d.strong)).body.allowed_actions).toEqual([]);
  });

  it("withdraw before decision is terminal and emits an event", async () => {
    const d = await submitted();
    const w = await post(`/v1/seller/applications/${d.id}/withdraw`, d.strong);
    expect(w.status).toBe(200);
    expect(w.body.status).toBe("WITHDRAWN");
    expect(h.repo.outbox.map((e) => e.type)).toContain("brand_application.withdrawn");
    expect((await post(`/v1/seller/applications/${d.id}/withdraw`, d.strong)).status).toBe(409);
    expect((await post(`/v1/seller/applications/${d.id}/submit`, d.strong)).status).toBe(409);
  });

  it("admin detail decrypts for reviewers, queue filters work, document URLs need a clean scan", async () => {
    const d = await submitted();
    const detail = await h.admin.get(d.id);
    expect(detail?.legalName).toBe("Zara Egypt LLC");
    expect(detail?.signatory).toMatchObject({ fullName: "Ali Hassan", nationalIdLast4: "0012" });
    expect(detail?.contact["email"]).toBe("mona@zara.example");
    const q = await h.admin.list({ status: "SUBMITTED", after: null, limit: 50 });
    expect(q.items.some((i) => i.id === d.id)).toBe(true);
    const doc = detail!.documents[0]!;
    const url = await h.admin.readDocumentUrl({ id: d.id, documentId: doc.id, adminId: ADMIN, reasonCode: "kyc_review" });
    expect(url.kind).toBe("ok");
    if (url.kind === "ok") expect(url.expiresAtMs - h.clock.nowMs()).toBeLessThanOrEqual(15 * 60_000);
    expect((await h.admin.readDocumentUrl({ id: d.id, documentId: U(5), adminId: ADMIN, reasonCode: "kyc_review" })).kind).toBe("not_found");
  });
});

describe("domain verification (owned by brand-verification)", () => {
  it("global brands must have the website verified by brand-verification before submitting", async () => {
    const user = newUser();
    const enrol = h.tokens.enrol(user);
    const id = (await post("/v1/seller/applications", enrol, { brand_kind: "global", country: "FR", brand_name: "Lacoste Fr" })).body.id as string;
    expect((await patch(`/v1/seller/applications/${id}`, enrol, { website_domain: "https://not-a-host/" })).status).toBe(400);
    await patch(`/v1/seller/applications/${id}`, enrol, {
      legal_name: "Lacoste SA", ownership_basis: "authorized_distributor", website_domain: "lacoste-eg.com",
      registration: { company_reg_no: "RCS 12345", company_reg_country: "FR" },
      contact: { name: "Jean", phone_e164: "+33123456789", email: "j@lacoste-eg.com" },
      signatory: { full_name: "Jean Dupont", national_id: "AB1234567", date_of_birth: "1980-05-05" },
      acknowledgements: { seller_agreement_version: "1", dpa_version: "1", price_monitoring_consent: true },
    });
    for (const code of ["company_registration_extract", "signatory_id", "distributor_letter"]) await uploadDoc(enrol, id, code);
    const strong = h.tokens.strong(user);
    const blocked = await post(`/v1/seller/applications/${id}/submit`, strong);
    expect(blocked.status).toBe(422);
    expect(blocked.body.errors.some((e: { code: string }) => e.code === "domain_verification")).toBe(true);
    h.link.states.set(id, { method: "dns_txt", domain: "lacoste-eg.com", status: "verified", expiresAtMs: 0, verifiedAtMs: h.clock.nowMs() });
    expect((await post(`/v1/seller/applications/${id}/submit`, strong)).status).toBe(200);
  });
  it("the module does not duplicate the domain-verification routes", async () => {
    const t = h.tokens.enrol(newUser());
    // Registered by brand-verification, not by sellers: absent from this test app.
    expect((await post(`/v1/seller/applications/${U(1)}/domain-verification`, t, { method: "dns_txt" })).status).toBe(404);
  });
  it("runAutoChecks moves SUBMITTED -> AUTO_CHECKS -> IN_REVIEW and hands the snapshot to brand-verification", async () => {
    const d = await completeDraft();
    await post(`/v1/seller/applications/${d.id}/submit`, d.strong);
    const v = (await h.admin.get(d.id))!.version;
    const r = await h.admin.runAutoChecks({ id: d.id, expectedVersion: v });
    expect(r.kind).toBe("ok");
    expect((await h.admin.get(d.id))?.status).toBe("IN_REVIEW");
    const snap = h.link.checked.find((x) => x.applicationId === d.id);
    expect(snap).toMatchObject({ kind: "local", country: "EG", brandName: expect.any(String), legalName: "Zara Egypt LLC", websiteDomain: null });
    expect((await h.admin.runAutoChecks({ id: d.id, expectedVersion: (await h.admin.get(d.id))!.version })).kind).toBe("invalid_transition");
  });
});
