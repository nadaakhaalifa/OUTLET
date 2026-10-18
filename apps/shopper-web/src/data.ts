import { ApiError, type schemas } from "@outlet/api-client";
import { publicClient } from "./api/transport";

export type Loaded<T> =
  | { readonly kind: "ok"; readonly data: T }
  | { readonly kind: "not_found" }
  /** 410: delisted. Next cannot emit 410 from a page, so pages answer it with notFound() (404). */
  | { readonly kind: "gone" }
  | { readonly kind: "unavailable" };

async function load<T>(run: (c: NonNullable<ReturnType<typeof publicClient>>) => Promise<T>): Promise<Loaded<T>> {
  const client = publicClient();
  if (client === null) return { kind: "unavailable" };
  try {
    return { kind: "ok", data: await run(client) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 410) return { kind: "gone" };
    if (e instanceof ApiError && e.status === 404) return { kind: "not_found" };
    // 401/403/5xx, timeouts and contract drift all mean "cannot show trustworthy data": fail closed.
    return { kind: "unavailable" };
  }
}

const data = <T extends { notModified: boolean }>(r: T): Exclude<T, { notModified: true }> => {
  if (r.notModified) throw new Error("unexpected 304");
  return r as Exclude<T, { notModified: true }>;
};

export const loadDrops = (cursor?: string) =>
  load<schemas.PublicDropPage>(async (c) => data(await c.listPublicDrops({ query: { limit: 24, ...(cursor === undefined ? {} : { cursor }) } })).data);

export const loadDrop = (id: string) =>
  load<schemas.PublicDropDetail>(async (c) => data(await c.getPublicDrop({ path: { id } })).data);

export const loadStores = (cursor?: string, limit = 24) =>
  load<schemas.PublicStorePage>(async (c) =>
    data(await c.listPublicStores({ query: { world: "everything", sort: "trending", limit, ...(cursor === undefined ? {} : { cursor }) } })).data);

export const loadStore = (id: string) =>
  load<schemas.PublicStore>(async (c) => data(await c.getPublicStore({ path: { storeId: id } })).data);

export const loadProduct = (id: string) =>
  load<schemas.PublicProduct>(async (c) => data(await c.getPublicProduct({ path: { productId: id } })).data);

export const loadEvidence = (id: string) =>
  load<schemas.PriceEvidence>(async (c) => data(await c.getProductPriceEvidence({ path: { productId: id } })).data);

export const loadHistory = (id: string) =>
  load<schemas.PriceHistory>(async (c) => data(await c.getProductPriceHistory({ path: { productId: id } })).data);

export const loadSearch = (q: string, cursor?: string, storeId?: string) =>
  load<schemas.PublicSearchResults>(async (c) =>
    data(await c.searchPublic({
      query: {
        limit: 24,
        ...(q === "" ? {} : { q }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(storeId === undefined ? {} : { filters: JSON.stringify({ store_ids: [storeId] }) }),
      },
    })).data);

/** Pages through /v1/public/sitemap/stores/{page}; stops at next_page null or the 1000-page contract cap. */
export async function loadStoreSitemap(): Promise<readonly schemas.PublicStoreSitemapPage["items"][number][]> {
  const client = publicClient();
  if (client === null) return [];
  const out: schemas.PublicStoreSitemapPage["items"][number][] = [];
  try {
    let page: number | null = 1;
    while (page !== null && page <= 1000) {
      const r: schemas.PublicStoreSitemapPage = data(await client.getPublicStoreSitemap({ path: { page } })).data;
      out.push(...r.items);
      page = r.page.next_page;
    }
  } catch {
    // Fail closed: a partial sitemap is still valid; never fabricate entries.
  }
  return out;
}

export async function loadProductSitemap(): Promise<readonly schemas.PublicProductSitemapPage["items"][number][]> {
  const client = publicClient();
  if (client === null) return [];
  const out: schemas.PublicProductSitemapPage["items"][number][] = [];
  try {
    let page: number | null = 1;
    while (page !== null && page <= 1000) {
      const r: schemas.PublicProductSitemapPage = data(await client.getPublicProductSitemap({ path: { page } })).data;
      out.push(...r.items);
      page = r.page.next_page;
    }
  } catch {
    // Fail closed.
  }
  return out;
}
