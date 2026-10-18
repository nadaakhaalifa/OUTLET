import type { MetadataRoute } from "next";
import { loadDrops, loadProductSitemap, loadStoreSitemap } from "../data";
import { alternatesFor, entitySegment, productSegment } from "../lib/paths";
import { SITE } from "../lib/site";
import { isIndexableDrop } from "../view-models/drops";

export const revalidate = 300;

const entry = (path: string, lastModified?: string): MetadataRoute.Sitemap[number] => {
  const a = alternatesFor(SITE, "ar", path);
  return { url: a.canonical, alternates: { languages: a.languages }, ...(lastModified === undefined ? {} : { lastModified }) };
};

/** Built from /v1/public/sitemap/* (paged) and drops. `lastModified` only where the API supplies a real timestamp. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const out: MetadataRoute.Sitemap = [entry(""), entry("/drops")];
  const [drops, stores, products] = await Promise.all([loadDrops(), loadStoreSitemap(), loadProductSitemap()]);
  if (drops.kind === "ok") for (const d of drops.data.items) if (isIndexableDrop(d)) out.push(entry(`/drops/${d.id}`));
  for (const s of stores) out.push(entry(`/s/${entitySegment(s.id, s.slug, s.slug)}`));
  for (const p of products) out.push(entry(`/p/${productSegment(p.id)}`, p.lastmod));
  return out;
}
