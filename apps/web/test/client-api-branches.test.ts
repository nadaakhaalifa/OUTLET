import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProblem, createBrowserApi } from "../src/lib/client-api";
import { ids, ids2, m, wireReturn, wireSellerOrder } from "./shop-fixtures";

const res = (status: number, body: unknown) => new Response(status === 204 ? null : typeof body === "string" ? body : JSON.stringify(body), { status });
interface Call { url: string; init: RequestInit }
function harness(reply: (c: Call) => Response) {
  const calls: Call[] = [];
  const f = vi.fn((url: string, init?: RequestInit) => {
    const c = { url, init: init ?? {} };
    calls.push(c);
    return Promise.resolve(reply(c));
  });
  return { api: createBrowserApi("eg", f as unknown as typeof fetch), calls };
}
const body = (c: Call) => JSON.parse(c.init.body as string) as Record<string, unknown>;
const orderWire = () => ({
  id: ids.ORDER, status: "PAID", currency: "EGP", items_subtotal: m(80_000), discount: m(0), shipping: m(6_000), vat: m(10_500), store_credit: m(0), total: m(86_000),
  payment_method: "card", payment_status: "captured", client_action: null, seller_orders: [wireSellerOrder()],
});
const page = (items: unknown[], next: string | null = null) => ({ items, next_cursor: next });

afterEach(() => { vi.unstubAllGlobals(); });

describe("default transport", () => {
  it("without an injected fetch it uses the global fetch, same-origin, and reports a problem", async () => {
    const g = vi.fn(() => Promise.resolve(res(404, { type: "urn:outlex:problem:not-found" })));
    vi.stubGlobal("fetch", g);
    const e = await createBrowserApi().getOrderGroup(ids.ORDER).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiProblem);
    expect(e).toMatchObject({ status: 404, type: "not-found" });
    expect(g).toHaveBeenCalledTimes(1);
    const [url, init] = g.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/bff/eg/order-groups/${ids.ORDER}`);
    expect(init.credentials).toBe("same-origin");
  });
});

describe("addresses carry only what was set", () => {
  const base = { recipientName: "منى", phoneE164: "+201012345678", governorateId: "g1", districtId: "d1", street: "س", building: "1", floor: "", apartment: "", landmark: "ل" };
  it("is_default, label and pin are sent when given and omitted when absent or null", async () => {
    const h = harness(() => res(200, {}));
    await h.api.createAddress(base).catch(() => undefined);
    await h.api.createAddress({ ...base, isDefault: true, label: "Home", pin: { lat_e7: 301234567, lng_e7: 311234567 } }).catch(() => undefined);
    await h.api.createAddress({ ...base, isDefault: false, label: null, pin: null }).catch(() => undefined);
    const [a, b, c] = h.calls.map(body);
    expect(a).not.toHaveProperty("is_default");
    expect(a).not.toHaveProperty("label");
    expect(a).not.toHaveProperty("pin");
    expect(b).toMatchObject({ is_default: true, label: "Home", pin: { lat_e7: 301234567, lng_e7: 311234567 } });
    expect(c).toMatchObject({ is_default: false });
    expect(c).not.toHaveProperty("label");
    expect(c).not.toHaveProperty("pin");
  });
});

describe("orders and returns", () => {
  it("lists with a first page and a cursor (URL-encoded) and maps next_cursor", async () => {
    const h = harness((c) => (c.url.includes("returns") ? res(200, page([wireReturn()], "r 2")) : res(200, page([], "o+2"))));
    const o1 = await h.api.listOrders();
    const o2 = await h.api.listOrders("a b&c");
    const r1 = await h.api.listReturns("x/y");
    expect(h.calls.map((c) => c.url)).toEqual(["/api/bff/eg/order-groups?limit=20", "/api/bff/eg/order-groups?limit=20&cursor=a%20b%26c", "/api/bff/eg/returns?limit=20&cursor=x%2Fy"]);
    expect(o1.nextCursor).toBe("o+2");
    expect(o2.nextCursor).toBe("o+2");
    expect(r1.items).toHaveLength(1);
    expect(r1.nextCursor).toBe("r 2");
  });

  it("cancelling a seller order sends the reason, and the refund preference only when chosen", async () => {
    const h = harness(() => res(200, orderWire()));
    await h.api.cancelSellerOrder(ids.ORDER, ids2.SO, { reasonCode: "ordered_by_mistake" });
    await h.api.cancelSellerOrder(ids.ORDER, ids2.SO, { reasonCode: "changed_mind", refundPreference: "store_credit" });
    expect(h.calls[0]?.url).toBe(`/api/bff/eg/order-groups/${ids.ORDER}/seller-orders/${ids2.SO}/cancel`);
    expect(body(h.calls[0]!)).toEqual({ reason_code: "ordered_by_mistake" });
    expect(body(h.calls[1]!)).toEqual({ reason_code: "changed_mind", refund_preference: "store_credit" });
  });

  it("a return carries a refund preference and evidence ids only when present", async () => {
    const h = harness(() => res(200, wireReturn()));
    const lines = [{ orderLineId: ids2.ORDER_LINE, qty: 1 }];
    await h.api.createReturn(ids2.SO, { lines, reasonCode: "too_small", method: "pickup", resolution: "exchange", evidenceMediaIds: [] });
    await h.api.createReturn(ids2.SO, { lines, reasonCode: "defective", method: "dropoff", resolution: "refund", refundPreference: "original", evidenceMediaIds: [ids.LINE] });
    expect(body(h.calls[0]!)).toEqual({ lines: [{ order_line_id: ids2.ORDER_LINE, qty: 1 }], reason_code: "too_small", method: "pickup", resolution: "exchange" });
    expect(body(h.calls[1]!)).toMatchObject({ refund_preference: "original", evidence_media_ids: [ids.LINE], method: "dropoff", resolution: "refund" });
  });

  it("a dispute sends the statement and attaches media only when there is some", async () => {
    const h = harness(() => res(204, null));
    await h.api.openDispute(ids2.RETURN, { statement: "It was never worn", mediaIds: [] });
    await h.api.openDispute(ids2.RETURN, { statement: "Photos attached", mediaIds: [ids.LINE, ids.ADDR] });
    expect(h.calls[0]?.url).toBe(`/api/bff/eg/returns/${ids2.RETURN}/dispute`);
    expect(body(h.calls[0]!)).toEqual({ statement: "It was never worn" });
    expect(body(h.calls[1]!)).toEqual({ statement: "Photos attached", media_ids: [ids.LINE, ids.ADDR] });
  });
});

describe("evidence upload", () => {
  const ticket = (headers: Record<string, unknown>) => ({ media_id: ids.LINE, upload_url: "https://storage.example/put/abc", upload_headers: headers, expires_at: "2026-11-08T10:00:00Z" });
  const file = () => new File([new Uint8Array([1, 2, 3, 4])], "p.jpg", { type: "image/jpeg" });

  it("announces the file by hash, PUTs the bytes with the signed string headers only, then completes", async () => {
    const h = harness((c) => (c.url.startsWith("https://storage") ? res(200, "") : c.url.endsWith("/uploads") ? res(200, ticket({ "x-amz-meta": "v", "content-length": 4, "x-skip": null })) : res(204, null)));
    expect(await h.api.uploadEvidence(file(), "return_evidence")).toBe(ids.LINE);
    expect(h.calls.map((c) => `${c.init.method ?? ""} ${c.url}`)).toEqual(["POST /api/bff/eg/media/uploads", "PUT https://storage.example/put/abc", `POST /api/bff/eg/media/${ids.LINE}/complete`]);
    expect(body(h.calls[0]!)).toMatchObject({ purpose: "return_evidence", mime: "image/jpeg", bytes: 4 });
    expect(String(body(h.calls[0]!).sha256)).toMatch(/^[0-9a-f]{64}$/);
    expect(h.calls[1]?.init.headers).toEqual({ "x-amz-meta": "v" });
  });

  it("a refused PUT is an upload-failed problem and the upload is never marked complete", async () => {
    const h = harness((c) => (c.url.startsWith("https://storage") ? res(403, "denied") : res(200, ticket({}))));
    const e = await h.api.uploadEvidence(file(), "return_evidence").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiProblem);
    expect(e).toMatchObject({ status: 403, type: "upload-failed" });
    expect(h.calls.some((c) => c.url.endsWith("/complete"))).toBe(false);
  });
});

describe("shape guards", () => {
  it("a wire order whose seller-order amounts are malformed is rejected, not trusted", async () => {
    const h = harness(() => res(200, { ...orderWire(), seller_orders: [wireSellerOrder({ total: "oops" })] }));
    await expect(h.api.getOrderGroup(ids.ORDER)).rejects.toThrow();
  });
});
