import { describe, expect, it, vi } from "vitest";
import { createOnboardingApi } from "../src/client/onboarding-api";

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const WIRE = { seller_id: "s", kyc_case_id: "c", status: "DRAFT", submitted_at: null, decided_at: null, decision_reason: null, version: 1, gaps: ["bank_account"], required_documents: ["tax_card"] };

describe("onboarding client", () => {
  it("GETs without an idempotency key and writes with one, parsing the served shapes", async () => {
    const f = vi.fn<typeof fetch>((url, init) => {
      const u = typeof url === "string" ? url : "";
      if (u.endsWith("/onboarding") && init?.method === "GET") return Promise.resolve(json(200, WIRE));
      if (u.endsWith("/onboarding") && init?.method === "POST") return Promise.resolve(json(201, { seller_id: "s", kyc_case_id: "c" }));
      if (u.endsWith("/bank-account")) return Promise.resolve(json(200, { iban_last4: "0002" }));
      return Promise.resolve(json(200, { ...WIRE, status: "SUBMITTED" }));
    });
    const api = createOnboardingApi("eg", f);
    expect(await api.get()).toMatchObject({ ok: true, data: { status: "DRAFT" } });
    expect(new Headers(f.mock.calls[0]?.[1]?.headers).has("idempotency-key")).toBe(false);
    expect(await api.start({ legal_type: "company" })).toMatchObject({ ok: true });
    expect(await api.setBank("EG1", "x")).toEqual({ ok: true, data: { iban_last4: "0002" } });
    const put = f.mock.calls[2];
    expect(put?.[1]?.method).toBe("PUT");
    expect(new Headers(put?.[1]?.headers).get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect(await api.submit()).toMatchObject({ ok: true, data: { status: "SUBMITTED" } });
  });

  it("maps Problems (with gap reasons), unknown bodies, bad shapes and network failure", async () => {
    const seq: (() => Response)[] = [
      () => json(422, { code: "kyc-incomplete", errors: [{ code: "bank_account" }] }),
      () => new Response("<html>", { status: 502 }),
      () => json(200, { nope: 1 }),
      () => { throw new Error("offline"); },
      () => json(422, { code: "x" }),
    ];
    const api = createOnboardingApi("eg", () => Promise.resolve(seq.shift()?.() ?? json(500, {})));
    expect(await api.submit()).toEqual({ ok: false, status: 422, code: "kyc-incomplete", reasons: ["bank_account"] });
    expect(await api.get()).toEqual({ ok: false, status: 502, code: "unknown", reasons: [] });
    expect(await api.get()).toMatchObject({ ok: false, code: "bad-response" });
    expect(await api.get()).toEqual({ ok: false, status: 0, code: "network", reasons: [] });
    expect(await api.submit()).toEqual({ ok: false, status: 422, code: "x", reasons: [] });
  });
});

class FakeXhr {
  status = 201;
  responseText = JSON.stringify({ document_id: "d", media_id: "m", doc_type: "tax_card" });
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  headers: Record<string, string> = {};
  sent: FormData | null = null;
  url = "";
  open(_m: string, url: string): void { this.url = url; }
  setRequestHeader(k: string, v: string): void { this.headers[k] = v; }
  send(body: FormData): void { this.sent = body; }
}
const upload = (setup: (x: FakeXhr) => void, fire: (x: FakeXhr) => void) => {
  const x = new FakeXhr();
  setup(x);
  const progress: number[] = [];
  const api = createOnboardingApi("eg", fetch, () => x as unknown as XMLHttpRequest);
  const p = api.uploadDocument("tax_card", new File(["%PDF"], "t.pdf", { type: "application/pdf" }), (f) => progress.push(f));
  fire(x);
  return { p, x, progress };
};

describe("document upload", () => {
  it("sends doc_type before the file and reports progress", async () => {
    const { p, x, progress } = upload(() => undefined, (x) => {
      x.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
      x.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
      x.onload?.();
    });
    expect(await p).toEqual({ ok: true, data: { document_id: "d" } });
    expect(progress).toEqual([0.25]);
    expect([...(x.sent?.keys() ?? [])]).toEqual(["doc_type", "file"]);
    expect(x.url).toBe("/api/seller/eg/onboarding/documents");
    expect(x.headers["idempotency-key"]).toBeTruthy();
  });
  it("maps HTTP errors, network errors and malformed bodies", async () => {
    expect(await upload((x) => { x.status = 422; x.responseText = JSON.stringify({ code: "media-rejected" }); }, (x) => x.onload?.()).p).toMatchObject({ ok: false, status: 422, code: "media-rejected" });
    expect(await upload(() => undefined, (x) => x.onerror?.()).p).toMatchObject({ ok: false, status: 0, code: "network" });
    expect(await upload((x) => { x.responseText = "{}"; }, (x) => x.onload?.()).p).toMatchObject({ ok: false, code: "bad-response" });
    expect(await upload((x) => { x.responseText = "nope"; }, (x) => x.onload?.()).p).toMatchObject({ ok: false, code: "bad-response" });
  });
});
