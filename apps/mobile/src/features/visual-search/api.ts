import { ApiError, dataOf, type schemas } from "../../services/api-client";
import { pick, piastres, toPortError, type AdapterContext } from "../../services/wire";
import {
  VisualSearchError, type PickedImage, type SearchOptions, type VisualItem, type VisualResults, type VisualSearchPort, type VisualFailureReason,
} from "./model";

/** Sends the picked photo to the signed target. Bytes go only to the URL the server issued, never anywhere else. */
export interface ImageUploader {
  measure(uri: string): Promise<number>;
  put(uri: string, target: { readonly url: string; readonly headers: Readonly<Record<string, string>> }): Promise<void>;
}

/** fetch-based uploader (no native module). The blob is read twice (size, then body) and never kept. */
export class FetchImageUploader implements ImageUploader {
  async measure(uri: string): Promise<number> {
    const blob = await (await fetch(uri)).blob();
    return blob.size;
  }
  async put(uri: string, target: { readonly url: string; readonly headers: Readonly<Record<string, string>> }): Promise<void> {
    const blob = await (await fetch(uri)).blob();
    const res = await fetch(target.url, { method: "PUT", headers: { ...target.headers }, body: blob });
    if (!res.ok) throw new Error(`upload failed with ${res.status}`);
  }
}

const REJECTED = new Set(["image_unsafe", "image_not_fashion", "image_infected", "image_malformed"]);
const TOO_LARGE = new Set(["image_too_large_bytes", "image_too_large_dimensions"]);

/** Maps the documented problem codes of /v1/search/visual to a reason the screen can explain. */
export function visualReasonFromError(e: unknown): VisualFailureReason | null {
  if (!(e instanceof ApiError)) return null;
  const code = e.code ?? "";
  if (e.status === 503) return code === "visual_search_disabled" ? "disabled" : "unavailable";
  if (e.status === 429) return "rateLimited";
  if (e.status === 409 && code === "upload_not_ready") return "busy";
  if (e.status === 422) {
    if (TOO_LARGE.has(code)) return "tooLarge";
    if (code === "image_unsupported_type") return "unsupportedType";
    if (REJECTED.has(code)) return "rejected";
  }
  return null;
}

function raise(e: unknown): never {
  const reason = visualReasonFromError(e);
  if (reason !== null) throw new VisualSearchError(reason);
  throw toPortError(e);
}

const RETRY_NOT_READY = 4;
const HYDRATE_MAX = 12;

/**
 * /v1/search/visual/uploads, PUT to the signed target, /v1/search/visual (the server deletes the object in a
 * `finally`), and /v1/products/{id}/visually-similar. The wire item has no title or store name, so the first
 * results are hydrated from `getProduct` (failure tolerant; a miss leaves the title empty).
 */
export class ApiVisualSearchPort implements VisualSearchPort {
  constructor(
    private readonly ctx: AdapterContext,
    private readonly uploader: ImageUploader = new FetchImageUploader(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async search(image: PickedImage, options?: SearchOptions): Promise<VisualResults> {
    try {
      if (image.contentType === null) throw new VisualSearchError("unsupportedType");
      const size = image.sizeBytes ?? (await this.uploader.measure(image.uri));
      const upload = dataOf(await this.ctx.client.issueVisualSearchUpload({ body: { content_type: image.contentType, size_bytes: size } }));
      await this.uploader.put(image.uri, { url: upload.url, headers: upload.headers });
      const body: schemas.VisualSearchRequest = {
        upload_id: upload.upload_id,
        ...(options?.crop !== undefined ? { crop: options.crop } : {}),
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
      };
      let attempt = 0;
      for (;;) {
        try {
          return await this.hydrate(dataOf(await this.ctx.client.searchByImage({ body })));
        } catch (e) {
          if (visualReasonFromError(e) === "busy" && attempt < RETRY_NOT_READY) {
            attempt += 1;
            await this.sleep(1000);
            continue;
          }
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof VisualSearchError) throw e;
      return raise(e);
    }
  }

  async similarTo(productId: string, limit = 12): Promise<VisualResults> {
    try {
      return await this.hydrate(dataOf(await this.ctx.client.getVisuallySimilarProducts({ path: { productId }, query: { limit } })));
    } catch (e) {
      return raise(e);
    }
  }

  private async hydrate(r: schemas.VisualSearchResults): Promise<VisualResults> {
    const lang = this.ctx.locale();
    const names = new Map<string, { title: string; store: string }>();
    await Promise.allSettled(
      r.items.slice(0, HYDRATE_MAX).map(async (i) => {
        const p = dataOf(await this.ctx.client.getProduct({ path: { productId: i.product_id } }));
        names.set(i.product_id, { title: pick(p.title, lang), store: pick(p.store.name, lang) });
      }),
    );
    const items = r.items.map((i): VisualItem => ({
      productId: i.product_id,
      storeId: i.store_id,
      categoryId: i.category_id,
      title: names.get(i.product_id)?.title ?? "",
      storeName: names.get(i.product_id)?.store ?? "",
      price: piastres(i.price_piastres),
      verifiedPct: i.verified_discount_pct,
      match: i.match,
    }));
    return { items, lowConfidence: r.low_confidence, degraded: r.degraded, categoryGuess: r.category_guess };
  }
}
