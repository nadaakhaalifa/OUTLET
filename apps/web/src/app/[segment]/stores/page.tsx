import type { Metadata } from "next";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { z } from "zod";
import { EmptyState } from "../../../components/EmptyState";
import { StorefrontGrid } from "../../../components/ui";
import { pageMetadata } from "../../../lib/metadata";
import { toStoreCard } from "../../../lib/present";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";
import type { StoreWorld } from "../../../server/api-client";
import { loadRootCategories, loadStoreDirectory } from "../../../server/loaders";

const PAGE_SIZE = 18;
const WORLDS = ["both", "local", "global"] as const satisfies readonly StoreWorld[];
const first = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);
const searchSchema = z.object({
  world: z.enum(WORLDS).catch("both"),
  category: z.uuid().optional().catch(undefined),
  cursor: z.string().max(512).optional().catch(undefined),
});
type Search = Promise<{ world?: string | string[]; category?: string | string[]; cursor?: string | string[] }>;

export async function generateMetadata({ params }: { params: SegmentParams }): Promise<Metadata> {
  return pageMetadata(await requireLocale(params), "/stores", "stores.title");
}

/** Server-rendered directory. Filters and "load more" are plain links (keyset cursor in the URL): no client fetch. */
export default async function StoresPage({ params, searchParams }: { params: SegmentParams; searchParams: Search }) {
  const resolved = await requireLocale(params);
  const raw = await searchParams;
  const q = searchSchema.parse({ world: first(raw.world), category: first(raw.category), cursor: first(raw.cursor) });
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const [{ stores, nextCursor }, categories] = await Promise.all([
    loadStoreDirectory(resolved.marketId, { world: q.world, limit: PAGE_SIZE, ...(q.category ? { categoryId: q.category } : {}), ...(q.cursor ? { cursor: q.cursor } : {}) }),
    loadRootCategories(resolved.marketId),
  ]);
  const href = (over: { world?: StoreWorld; category?: string | null; cursor?: string }): string => {
    const p = new URLSearchParams();
    const world = over.world ?? q.world;
    const category = over.category === undefined ? q.category : (over.category ?? undefined);
    if (world !== "both") p.set("world", world);
    if (category) p.set("category", category);
    if (over.cursor) p.set("cursor", over.cursor);
    return p.size > 0 ? `${base}/stores?${p.toString()}` : `${base}/stores`;
  };
  const cards = stores.map((s) => toStoreCard(s, resolved.locale, base, t(s.kind === "local" ? "store.kindLocal" : "store.kindGlobal")));
  return (
    <section aria-labelledby="stores-title">
      <h1 id="stores-title" className="hero">
        {t("stores.title")}
      </h1>
      <nav aria-label={t("stores.worldLabel")}>
        <ul className="filterRow">
          {WORLDS.map((w) => (
            <li key={w}>
              <a className="filterLink" href={href({ world: w })} aria-current={q.world === w ? "true" : "false"}>
                {t(`stores.world.${w}`)}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      {categories.length > 0 ? (
        <nav aria-label={t("stores.categoryLabel")}>
          <ul className="filterRow">
            <li>
              <a className="filterLink" href={href({ category: null })} aria-current={q.category === undefined ? "true" : "false"}>
                {t("category.all")}
              </a>
            </li>
            {categories.map((c) => (
              <li key={c.id}>
                <a className="filterLink" href={href({ category: c.id })} aria-current={q.category === c.id ? "true" : "false"}>
                  {resolved.locale.startsWith("en") && c.nameEn ? c.nameEn : c.nameAr}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
      {cards.length === 0 ? (
        <EmptyState locale={resolved.locale} titleKey="stores.empty" hintKey="stores.emptyHint" />
      ) : (
        <>
          <h2 className="sectionTitle">{t("village.gridTitle")}</h2>
          <StorefrontGrid stores={cards} locale={resolved.locale} />
        </>
      )}
      {nextCursor !== null ? (
        <p>
          <a className="filterLink" rel="next" href={href({ cursor: nextCursor })}>
            {t("stores.loadMore")}
          </a>
        </p>
      ) : null}
    </section>
  );
}
