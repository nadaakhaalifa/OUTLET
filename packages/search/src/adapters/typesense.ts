import type { Logger } from "@outlet/logger";
import { z } from "zod";
import type { EngineDocument, SearchEnginePort } from "../engine.js";

/** Thrown while the breaker is open: nothing is sent, reconcileEngine counts the document as failed and parks it (stays pending). */
export class SearchEngineCircuitOpenError extends Error {
  constructor() {
    super("search_engine_circuit_open");
    this.name = "SearchEngineCircuitOpenError";
  }
}

/** Transport, status or schema failure talking to Typesense. The message carries a code only: never a URL with credentials, a header or a body. */
export class SearchEngineError extends Error {
  constructor(readonly code: string) {
    super(`search_engine_error:${code}`);
    this.name = "SearchEngineError";
  }
}

export const TYPESENSE_COLLECTION = "outlet_products";
export const TYPESENSE_TIMEOUT_MS = 5_000;
export const BREAKER_THRESHOLD = 5;
export const BREAKER_OPEN_MS = 60_000;

/** Fields a Typesense document may carry. The mapper drops everything else, so a future column (PII or not) never reaches the engine by accident. */
export const TYPESENSE_FIELD_ALLOW_LIST = [
  "id", "market_id", "product_id", "store_ref", "category_id", "world", "title_ar", "title_en", "search_text", "price_minor", "currency",
  "condition_grade", "sizes", "verified_discount", "lowest_30d", "in_stock", "is_published", "seq",
] as const;
type AllowedField = (typeof TYPESENSE_FIELD_ALLOW_LIST)[number];
export type TypesenseDocument = Readonly<Partial<Record<AllowedField, unknown>>>;

const safeInt = (s: string, what: string): number => {
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new SearchEngineError(`unsafe_integer_${what}`);
  return n;
};

/** Pure mapper. `extra` models "a row with more columns than the port defines": anything outside the allow-list is discarded. */
export const toTypesenseDocument = (doc: EngineDocument): TypesenseDocument => {
  const full: Record<string, unknown> = {
    id: `${doc.marketId}:${doc.productId}`, market_id: doc.marketId, product_id: doc.productId, store_ref: doc.storeRef, world: doc.world,
    title_ar: doc.titleAr, title_en: doc.titleEn, search_text: doc.searchText, price_minor: safeInt(doc.priceMinor, "price"), currency: doc.currency,
    condition_grade: doc.conditionGrade, sizes: [...doc.sizes], verified_discount: doc.verifiedDiscount, lowest_30d: doc.lowest30d, in_stock: doc.inStock,
    is_published: doc.isPublished, seq: safeInt(doc.seq, "seq"),
    ...(doc.categoryId === null ? {} : { category_id: doc.categoryId }),
  };
  const out: Record<string, unknown> = {};
  for (const k of TYPESENSE_FIELD_ALLOW_LIST) if (k in full) out[k] = full[k];
  return out;
};

/** Collection schema derived from search_documents: Arabic fields use the `ar` locale, money is int64 minor units, flags are bools. */
export const typesenseSchema = (name = TYPESENSE_COLLECTION) => ({
  name,
  fields: [
    { name: "market_id", type: "string", facet: true },
    { name: "product_id", type: "string" },
    { name: "store_ref", type: "string", facet: true },
    { name: "category_id", type: "string", facet: true, optional: true },
    { name: "world", type: "string", facet: true },
    { name: "title_ar", type: "string", locale: "ar" },
    { name: "title_en", type: "string" },
    { name: "search_text", type: "string", locale: "ar" },
    { name: "price_minor", type: "int64" },
    { name: "currency", type: "string", facet: true },
    { name: "condition_grade", type: "string", facet: true },
    { name: "sizes", type: "string[]", facet: true },
    { name: "verified_discount", type: "bool" },
    { name: "lowest_30d", type: "bool" },
    { name: "in_stock", type: "bool" },
    { name: "is_published", type: "bool" },
    { name: "seq", type: "int64" },
  ],
  default_sorting_field: "seq",
});

const healthSchema = z.object({ ok: z.boolean() });
const collectionSchema = z.object({ name: z.string() });
const importLine = z.object({ success: z.boolean(), error: z.string().optional() });
const deleteSchema = z.object({ num_deleted: z.number().int().nonnegative() });

export interface TypesenseOptions {
  readonly url: string;
  /** Sent as X-TYPESENSE-API-KEY only. Never logged, never in an error message. */
  readonly apiKey: string;
  readonly collection?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly log?: Logger;
}

export interface UpsertResult {
  readonly succeeded: number;
  readonly failed: readonly { readonly id: string; readonly error: string }[];
}

/**
 * Typesense adapter behind SearchEnginePort (ADR-0017). The index is a mirror of search_documents, never the source of truth. Every response is
 * Zod-parsed, every call has a 5 s timeout, and a breaker opens after 5 consecutive transport/5xx/429/parse failures for 60 s.
 */
export class TypesenseEngine implements SearchEnginePort {
  readonly configured = true;
  private readonly base: string;
  private readonly name: string;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private failures = 0;
  private openUntil = 0;
  private ensured = false;

  constructor(private readonly o: TypesenseOptions) {
    this.base = o.url.replace(/\/+$/, "");
    this.name = o.collection ?? TYPESENSE_COLLECTION;
    this.timeoutMs = o.timeoutMs ?? TYPESENSE_TIMEOUT_MS;
    this.doFetch = o.fetch ?? fetch;
    this.now = o.now ?? Date.now;
  }

  get breakerOpen(): boolean {
    return this.now() < this.openUntil;
  }

  private async call(method: string, path: string, body?: string, accept: readonly number[] = []): Promise<{ status: number; text: string }> {
    if (this.breakerOpen) throw new SearchEngineCircuitOpenError();
    let res: Response;
    let text: string;
    try {
      res = await this.doFetch(`${this.base}${path}`, {
        method, signal: AbortSignal.timeout(this.timeoutMs),
        headers: { "X-TYPESENSE-API-KEY": this.o.apiKey, ...(body === undefined ? {} : { "Content-Type": method === "POST" && path.includes("/import") ? "text/plain" : "application/json" }) },
        ...(body === undefined ? {} : { body }),
      });
      text = await res.text();
    } catch (e) {
      throw this.fail(e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "network");
    }
    if (res.status === 429 || res.status >= 500) throw this.fail(`http_${String(res.status)}`);
    if (!res.ok && !accept.includes(res.status)) {
      this.o.log?.warn("search.typesense: request rejected", { method, path: path.split("?")[0], status: res.status });
      throw new SearchEngineError(`http_${String(res.status)}`);
    }
    this.failures = 0;
    return { status: res.status, text };
  }

  private fail(code: string): SearchEngineError {
    this.failures += 1;
    if (this.failures >= BREAKER_THRESHOLD) {
      this.openUntil = this.now() + BREAKER_OPEN_MS;
      this.failures = 0;
      this.o.log?.warn("search.typesense: circuit opened", { for_ms: BREAKER_OPEN_MS, code });
    }
    return new SearchEngineError(code);
  }

  private parse<T>(schema: z.ZodType<T>, text: string): T {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw this.fail("bad_json");
    }
    const r = schema.safeParse(json);
    if (!r.success) throw this.fail("bad_shape");
    return r.data;
  }

  async health(): Promise<boolean> {
    try {
      return this.parse(healthSchema, (await this.call("GET", "/health")).text).ok;
    } catch {
      return false;
    }
  }

  /** Idempotent: GET first, create on 404, a 409 race counts as present. Memoised after the first success. */
  async ensureCollection(): Promise<void> {
    if (this.ensured) return;
    const got = await this.call("GET", `/collections/${encodeURIComponent(this.name)}`, undefined, [404]);
    if (got.status === 404) {
      const made = await this.call("POST", "/collections", JSON.stringify(typesenseSchema(this.name)), [409]);
      if (made.status !== 409) this.parse(collectionSchema, made.text);
    } else {
      this.parse(collectionSchema, got.text);
    }
    this.ensured = true;
  }

  async upsertDocuments(batch: readonly EngineDocument[]): Promise<UpsertResult> {
    if (batch.length === 0) return { succeeded: 0, failed: [] };
    await this.ensureCollection();
    const docs = batch.map((d) => toTypesenseDocument(d));
    const res = await this.call("POST", `/collections/${encodeURIComponent(this.name)}/documents/import?action=upsert`, docs.map((d) => JSON.stringify(d)).join("\n"));
    const lines = res.text.split("\n").filter((l) => l.length > 0);
    if (lines.length !== docs.length) throw this.fail("import_response_mismatch");
    let succeeded = 0;
    const failed: { id: string; error: string }[] = [];
    lines.forEach((l, i) => {
      const r = this.parse(importLine, l);
      if (r.success) succeeded += 1;
      else failed.push({ id: String(docs[i]?.id), error: (r.error ?? "unknown").slice(0, 200) });
    });
    return { succeeded, failed };
  }

  async deleteDocuments(ids: readonly string[]): Promise<number> {
    if (ids.length === 0) return 0;
    await this.ensureCollection();
    const filter = `id:[${ids.map((i) => `\`${i.replaceAll("`", "")}\``).join(",")}]`;
    const res = await this.call("DELETE", `/collections/${encodeURIComponent(this.name)}/documents?filter_by=${encodeURIComponent(filter)}`);
    return this.parse(deleteSchema, res.text).num_deleted;
  }

  /** Port method used by reconcileEngine: one document, a per-document import failure throws so the row stays pending. */
  async index(doc: EngineDocument): Promise<void> {
    const r = await this.upsertDocuments([doc]);
    if (r.failed.length > 0) throw new SearchEngineError("import_rejected");
  }
}
