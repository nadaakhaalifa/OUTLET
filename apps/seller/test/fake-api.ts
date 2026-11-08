import { vi } from "vitest";
import type { ApiFailure, ApiResult, AttributeSetWire, ProductWire, SellerApi, ShipmentWire } from "../src/client/seller-api";

export const CATEGORY = "00000000-0000-4000-8000-0000000c0011";
export const ATTRIBUTES: AttributeSetWire = {
  category_id: CATEGORY,
  attributes: [
    { code: "colour", data_type: "enum", required: true, options: [{ code: "black", label_ar: "أسود", label_en: "Black" }] },
    { code: "size_run", data_type: "size_run", required: true, options: [] },
  ],
  defect_types: [{ code: "stain", label_ar: "بقعة", label_en: "Stain", default_severity: "minor" }],
};

export const product = (over: Partial<ProductWire> = {}): ProductWire => ({
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  status: "DRAFT",
  attributes: {},
  media: [],
  skus: [],
  ...over,
});

export const fail = (status: number, code: string, reasons: string[] = []): ApiFailure => ({ ok: false, status, code, reasons });
export const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });

/** An in-memory seller API with the server's version counter, so tests can assert If-Match sequencing. */
export const fakeApi = (script: { onPatch?: (version: number, body: object) => ApiResult<ProductWire> | undefined; reasons?: () => string[]; onPublish?: () => ApiResult<{ status: string; blocked_reasons: string[] }> } = {}, start: ProductWire = product()) => {
  let server = start;
  let uploads = 0;
  let lastCard: object | undefined;
  let stock: { onHand: number; version: number } | undefined;
  const adjustments: { sku_id: string; delta: number; reason: string; expected_version?: number }[] = [];
  const api = {
    createDraft: vi.fn((_grade: string, categoryId: string) => {
      server = { ...server, primary_category_id: categoryId };
      return Promise.resolve(ok(server));
    }),
    getProduct: vi.fn(() => Promise.resolve(ok(server))),
    readiness: vi.fn(() => Promise.resolve(ok({ blocked_reasons: script.reasons?.() ?? [] }))),
    patch: vi.fn((_id: string, version: number, body: object) => {
      const scripted = script.onPatch?.(version, body);
      if (scripted !== undefined) return Promise.resolve(scripted);
      if (version !== server.version) return Promise.resolve(fail(409, "version-conflict"));
      server = { ...server, version: server.version + 1 };
      return Promise.resolve(ok(server));
    }),
    defectCard: vi.fn((_id: string, version: number, body?: object) => {
      lastCard = body;
      if (version !== server.version) return Promise.resolve(fail(409, "version-conflict"));
      server = { ...server, version: server.version + 1 };
      return Promise.resolve(ok({}));
    }),
    upload: vi.fn((_id: string, kind: "product" | "defect", _file: File, onProgress: (f: number) => void) => {
      onProgress(0.5);
      onProgress(1);
      uploads += 1;
      return Promise.resolve(ok({ media_id: `${kind}-${String(uploads)}` }));
    }),
    publish: vi.fn(() => Promise.resolve(script.onPublish?.() ?? ok({ status: "PUBLISHED", blocked_reasons: [] }))),
    categories: vi.fn(() => Promise.resolve(ok([{ id: CATEGORY, name: "فساتين", depth: 2, path: "fashion/women/dresses" }]))),
    attributeSet: vi.fn(() => Promise.resolve(ok(ATTRIBUTES))),
    stockLevel: vi.fn(() => Promise.resolve(ok(stock === undefined ? null : { sku_id: "sku", location_id: "loc", on_hand: stock.onHand, committed: 0, available: stock.onHand, low_stock: false, version: stock.version }))),
    adjustStock: vi.fn((body: { sku_id: string; delta: number; reason: string; expected_version?: number }) => {
      adjustments.push(body);
      stock = { onHand: (stock?.onHand ?? 0) + body.delta, version: (stock?.version ?? 0) + 1 };
      return Promise.resolve(ok({ sku_id: body.sku_id, location_id: "loc", on_hand: stock.onHand, committed: 0, available: stock.onHand, low_stock: false, version: stock.version }));
    }),
    acceptOrder: vi.fn((id: string) => Promise.resolve(ok({ id, status: "ACCEPTED", available_actions: ["pack"], total: { amount_minor: "100", currency: "EGP" } }))),
    rejectOrder: vi.fn((id: string) => Promise.resolve(ok({ id, status: "REJECTED_BY_SELLER", available_actions: [], total: { amount_minor: "100", currency: "EGP" } }))),
    packOrder: vi.fn((id: string) => Promise.resolve(ok({ id, status: "PACKED", available_actions: ["ship"], total: { amount_minor: "100", currency: "EGP" } }))),
    shipOrder: vi.fn((id: string): Promise<ApiResult<ShipmentWire>> => Promise.resolve(ok({ id, awb: "AWB1", label_url: null }))),
  } satisfies SellerApi;
  return {
    api,
    server: () => server,
    lastCard: () => lastCard,
    adjustments: () => adjustments,
    stock: () => stock,
    bump: () => {
      server = { ...server, version: server.version + 1 };
    },
  };
};
