import Link from "next/link";
import { z } from "zod";
import { createTranslator, localeSegment } from "@outlet/i18n";
import { InventoryTable } from "../../../components/inventory/InventoryTable";
import { PageFrame } from "../../../components/PageFrame";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";
import { sellerGet } from "../../../server/seller-get";

const Page = z.object({
  items: z.array(
    z.object({
      sku_id: z.string(), seller_sku: z.string(), size_label: z.string().nullable(), product_title_ar: z.string(),
      on_hand: z.number().int(), committed: z.number().int(), available: z.number().int(), low_stock: z.boolean(), version: z.number().int(),
    }),
  ),
  next_cursor: z.string().nullable(),
});

/** Must match LOW_STOCK_THRESHOLD in the API (the flag itself comes from the server). */
const LOW_STOCK_NOTE_UNITS = 3;

export default async function InventoryPage({ params, searchParams }: { params: SegmentParams; searchParams: Promise<{ cursor?: string }> }) {
  const resolved = await requireLocale(params);
  const { cursor } = await searchParams;
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const safeCursor = cursor !== undefined && /^[A-Za-z0-9_-]{1,512}$/.test(cursor) ? cursor : undefined;
  const result = await sellerGet(resolved.marketId.toLowerCase(), `inventory?limit=20${safeCursor === undefined ? "" : `&cursor=${safeCursor}`}`);
  const page = result.ok ? Page.safeParse(result.data) : null;
  return (
    <PageFrame resolved={resolved} current="inventory">
      <h1 className="pageTitle">{t("seller.inventory.title")}</h1>
      {!result.ok ? <ProblemBanner t={t} code={result.code} status={result.status} /> : null}
      {page?.success === true && page.data.items.length === 0 ? <p className="empty">{t("seller.inventory.empty")}</p> : null}
      {page?.success === true && page.data.items.length > 0 ? (
        <>
          <p className="hint">{t("seller.inventory.lowNote", { n: LOW_STOCK_NOTE_UNITS })}</p>
          <InventoryTable locale={resolved.locale} marketId={resolved.marketId} rows={page.data.items} />
          {page.data.next_cursor === null ? null : (
            <p>
              <Link className="btnLink" href={`${base}/inventory?cursor=${page.data.next_cursor}`}>
                {t("seller.inventory.next")}
              </Link>
            </p>
          )}
        </>
      ) : null}
    </PageFrame>
  );
}
