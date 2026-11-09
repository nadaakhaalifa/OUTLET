import { uuidv7 } from "@outlet/ids";
import { z } from "zod";

/** Browser-side client for the Seller Center BFF (`/api/seller/...`, same origin). Responses are validated with Zod. */

export const ProductWire = z.object({
  id: z.string(),
  version: z.number().int(),
  status: z.string(),
  title_ar: z.string().nullish(),
  description_ar: z.string().nullish(),
  primary_category_id: z.string().nullish(),
  condition_grade_code: z.string().nullish(),
  stock_reason: z.string().nullish(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  warranty_months: z.number().int().nullish(),
  warranty_kind: z.string().nullish(),
  included_accessories_ar: z.string().nullish(),
  media: z.array(z.object({ role: z.string(), media: z.object({ media_id: z.string() }) })).default([]),
  skus: z.array(z.object({ id: z.string(), price: z.object({ amount_minor: z.string(), currency: z.string() }) })).default([]),
  defect_card: z
    .object({
      summary_ar: z.string().nullish(),
      items: z.array(z.object({ defect_type_code: z.string(), location_ar: z.string(), severity: z.enum(["minor", "major"]), affects_function: z.boolean(), hotspot_x_bp: z.number().nullish(), hotspot_y_bp: z.number().nullish() })),
    })
    .nullish(),
});
export type ProductWire = z.infer<typeof ProductWire>;

const Readiness = z.object({ blocked_reasons: z.array(z.string()) });
const Upload = z.object({ media_id: z.string() });
const Publish = z.object({ status: z.string(), blocked_reasons: z.array(z.string()) });
const Category = z.object({ id: z.string(), name: z.string(), depth: z.number().int(), path: z.string() });
export type CategoryWire = z.infer<typeof Category>;
const CategoryPage = z.object({ items: z.array(Category), next_cursor: z.string().nullable() });
export const AttributeSetWire = z.object({
  category_id: z.string(),
  attributes: z.array(z.object({ code: z.string(), data_type: z.enum(["enum", "text", "number", "boolean", "size_run"]), required: z.boolean(), options: z.array(z.object({ code: z.string(), label_ar: z.string(), label_en: z.string().nullable() })) })),
  defect_types: z.array(z.object({ code: z.string(), label_ar: z.string(), label_en: z.string().nullable(), default_severity: z.enum(["minor", "major"]) })),
});
export type AttributeSetWire = z.infer<typeof AttributeSetWire>;

const Money = z.object({ amount_minor: z.string(), currency: z.string() });
export const LevelWire = z.object({
  sku_id: z.string(),
  location_id: z.string().nullable(),
  on_hand: z.number().int(),
  committed: z.number().int(),
  available: z.number().int(),
  low_stock: z.boolean(),
  version: z.number().int(),
});
export type LevelWire = z.infer<typeof LevelWire>;
const LevelPage = z.object({ items: z.array(LevelWire), next_cursor: z.string().nullable() });
export const STOCK_REASONS = ["recount", "damage", "received", "correction"] as const;
export type StockReason = (typeof STOCK_REASONS)[number];

export const OrderActionResult = z.object({ id: z.string(), status: z.string(), available_actions: z.array(z.string()), total: Money });
export type OrderActionResult = z.infer<typeof OrderActionResult>;
export const ShipmentWire = z.object({ id: z.string(), awb: z.string(), label_url: z.string().nullable() });
export type ShipmentWire = z.infer<typeof ShipmentWire>;
export const REJECT_REASONS = ["out_of_stock", "damaged", "pricing_error", "other"] as const;
export const CANCEL_REASONS = ["out_of_stock", "cannot_fulfil", "pricing_error", "other"] as const;
export type CancelReason = (typeof CANCEL_REASONS)[number];
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface ApiFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
  readonly reasons: readonly string[];
}
export type ApiResult<T> = { readonly ok: true; readonly data: T } | ApiFailure;

export interface SellerApi {
  createDraft(grade: string, categoryId: string): Promise<ApiResult<ProductWire>>;
  getProduct(id: string): Promise<ApiResult<ProductWire>>;
  readiness(id: string): Promise<ApiResult<{ blocked_reasons: string[] }>>;
  patch(id: string, version: number, body: object): Promise<ApiResult<ProductWire>>;
  defectCard(id: string, version: number, body: object): Promise<ApiResult<unknown>>;
  upload(id: string, kind: "product" | "defect", file: File, onProgress: (fraction: number) => void): Promise<ApiResult<{ media_id: string }>>;
  publish(id: string, version: number): Promise<ApiResult<{ status: string; blocked_reasons: string[] }>>;
  categories(): Promise<ApiResult<CategoryWire[]>>;
  attributeSet(categoryId: string): Promise<ApiResult<AttributeSetWire>>;
  /** Stock level of one SKU (null when it has no level yet). */
  stockLevel(skuId: string): Promise<ApiResult<LevelWire | null>>;
  adjustStock(body: { sku_id: string; delta: number; reason: StockReason; expected_version?: number }): Promise<ApiResult<LevelWire>>;
  acceptOrder(id: string): Promise<ApiResult<OrderActionResult>>;
  rejectOrder(id: string, reason: RejectReason, note?: string): Promise<ApiResult<OrderActionResult>>;
  cancelOrder(id: string, reason: CancelReason): Promise<ApiResult<OrderActionResult>>;
  packOrder(id: string): Promise<ApiResult<OrderActionResult>>;
  shipOrder(id: string, weightG: number): Promise<ApiResult<ShipmentWire>>;
}

const Problem = z.object({ code: z.string(), errors: z.array(z.object({ code: z.string() })).optional() });

const failure = async (res: { status: number; text(): Promise<string> }): Promise<ApiFailure> => {
  try {
    const p = Problem.safeParse(JSON.parse(await res.text()));
    if (p.success) return { ok: false, status: res.status, code: p.data.code, reasons: (p.data.errors ?? []).map((e) => e.code) };
  } catch {
    // not a Problem body
  }
  return { ok: false, status: res.status, code: "unknown", reasons: [] };
};

const NETWORK: ApiFailure = { ok: false, status: 0, code: "network", reasons: [] };

/** `market` is the lower-case market id of the page segment (eg). */
export const createSellerApi = (market: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): SellerApi => {
  const base = `/api/seller/${market}`;
  const call = async <T>(schema: z.ZodType<T>, path: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<ApiResult<T>> => {
    const method = init.method ?? "GET";
    const headers: Record<string, string> = { accept: "application/json", ...init.headers };
    if (method !== "GET") headers["idempotency-key"] = uuidv7();
    if (init.body !== undefined) headers["content-type"] = "application/json";
    try {
      const res = await fetchImpl(`${base}/${path}`, { method, headers, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
      if (!res.ok) return await failure(res);
      const parsed = schema.safeParse(await res.json());
      return parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: res.status, code: "bad-response", reasons: [] };
    } catch {
      return NETWORK;
    }
  };
  const ifMatch = (v: number): Record<string, string> => ({ "if-match": `"${String(v)}"` });
  return {
    createDraft: (grade, categoryId) => call(ProductWire, "products", { method: "POST", body: { condition_grade_code: grade, primary_category_id: categoryId } }),
    getProduct: (id) => call(ProductWire, `products/${id}`),
    readiness: (id) => call(Readiness, `products/${id}/readiness`),
    patch: (id, version, body) => call(ProductWire, `products/${id}`, { method: "PATCH", body, headers: ifMatch(version) }),
    defectCard: (id, version, body) => call(z.unknown(), `products/${id}/defect-cards`, { method: "POST", body, headers: ifMatch(version) }),
    publish: (id, version) => call(Publish, `products/${id}/publish`, { method: "POST", body: {}, headers: ifMatch(version) }),
    categories: async () => {
      const r = await call(CategoryPage, "categories?limit=50");
      return r.ok ? { ok: true, data: r.data.items } : r;
    },
    attributeSet: (categoryId) => call(AttributeSetWire, `attribute-sets/${categoryId}`),
    stockLevel: async (skuId) => {
      const r = await call(LevelPage, `inventory?limit=1&sku_id=${skuId}`);
      return r.ok ? { ok: true, data: r.data.items[0] ?? null } : r;
    },
    adjustStock: (body) => call(LevelWire, "inventory/adjustments", { method: "POST", body }),
    acceptOrder: (id) => call(OrderActionResult, `orders/${id}/accept`, { method: "POST", body: {} }),
    rejectOrder: (id, reason, note) => call(OrderActionResult, `orders/${id}/reject`, { method: "POST", body: { reason_code: reason, ...(note === undefined || note === "" ? {} : { note }) } }),
    cancelOrder: (id, reason) => call(OrderActionResult, `orders/${id}/cancel`, { method: "POST", body: { reason_code: reason } }),
    packOrder: (id) => call(OrderActionResult, `orders/${id}/pack`, { method: "POST", body: {} }),
    shipOrder: (id, weightG) => call(ShipmentWire, "shipments", { method: "POST", body: { seller_order_ids: [id], declared_weight_g: weightG } }),
    upload: (id, kind, file, onProgress) =>
      new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", `${base}/products/${id}/media`);
        xhr.setRequestHeader("idempotency-key", uuidv7());
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onerror = () => { resolve(NETWORK); };
        xhr.onload = () => {
          if (xhr.status < 200 || xhr.status >= 300) {
            void failure({ status: xhr.status, text: () => Promise.resolve(xhr.responseText) }).then(resolve);
            return;
          }
          try {
            const parsed = Upload.safeParse(JSON.parse(xhr.responseText));
            resolve(parsed.success ? { ok: true, data: parsed.data } : { ok: false, status: xhr.status, code: "bad-response", reasons: [] });
          } catch {
            resolve({ ok: false, status: xhr.status, code: "bad-response", reasons: [] });
          }
        };
        const form = new FormData();
        form.append("kind", kind); // the API reads `kind` before the file stream
        form.append("file", file, file.name);
        xhr.send(form);
      }),
  };
};
