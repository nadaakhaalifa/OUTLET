import Link from "next/link";
import { z } from "zod";
import { createTranslator, formatDate, localeSegment, type MessageKey } from "@outlet/i18n";
import { PageFrame } from "../../../components/PageFrame";
import { ProblemBanner } from "../../../components/ProblemBanner";
import { requireLocale, type SegmentParams } from "../../../lib/segment-page";
import { sellerGet } from "../../../server/seller-get";

const Page = z.object({
  items: z.array(z.object({ id: z.string(), status: z.string(), title_ar: z.string().nullish(), condition_grade_code: z.string().nullish(), sku_count: z.number().int(), updated_at: z.string() })),
  next_cursor: z.string().nullable(),
});

const STATUS: Readonly<Record<string, MessageKey>> = {
  DRAFT: "seller.status.DRAFT",
  IN_REVIEW: "seller.status.IN_REVIEW",
  PUBLISHED: "seller.status.PUBLISHED",
  PAUSED: "seller.status.PAUSED",
  SOLD_OUT: "seller.status.SOLD_OUT",
  ARCHIVED: "seller.status.ARCHIVED",
  BLOCKED: "seller.status.BLOCKED",
};
const GRADE: Readonly<Record<string, MessageKey>> = {
  new_with_tags: "seller.grade.new_with_tags",
  new_with_imperfections: "seller.grade.new_with_imperfections",
  sample: "seller.grade.sample",
  open_box: "seller.grade.open_box",
  refurbished: "seller.grade.refurbished",
  pre_owned: "seller.grade.pre_owned",
};

export default async function ProductsPage({ params, searchParams }: { params: SegmentParams; searchParams: Promise<{ cursor?: string }> }) {
  const resolved = await requireLocale(params);
  const { cursor } = await searchParams;
  const t = createTranslator(resolved.locale);
  const base = `/${localeSegment(resolved.marketId, resolved.locale)}`;
  const safeCursor = cursor !== undefined && /^[A-Za-z0-9_-]{1,512}$/.test(cursor) ? cursor : undefined;
  const result = await sellerGet(resolved.marketId.toLowerCase(), `products?limit=20${safeCursor === undefined ? "" : `&cursor=${safeCursor}`}`);
  const page = result.ok ? Page.safeParse(result.data) : null;
  return (
    <PageFrame resolved={resolved} current="products">
      <div className="titleRow">
        <h1 className="pageTitle">{t("seller.products.title")}</h1>
        <Link className="btnLink" href={`${base}/products/new`}>
          {t("seller.products.add")}
        </Link>
      </div>
      {!result.ok ? <ProblemBanner t={t} code={result.code} status={result.status} /> : null}
      {page?.success === true && page.data.items.length === 0 ? <p className="empty">{t("seller.products.empty")}</p> : null}
      {page?.success === true && page.data.items.length > 0 ? (
        <>
          <table className="table">
            <caption className="srOnly">{t("seller.products.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("seller.products.col.name")}</th>
                <th scope="col">{t("seller.products.col.status")}</th>
                <th scope="col">{t("seller.products.col.condition")}</th>
                <th scope="col">{t("seller.products.col.variants")}</th>
                <th scope="col">{t("seller.products.col.updated")}</th>
              </tr>
            </thead>
            <tbody>
              {page.data.items.map((p) => (
                <tr key={p.id}>
                  <th scope="row">
                    <Link href={`${base}/products/${p.id}`}>{p.title_ar ?? t("seller.products.untitled")}</Link>
                  </th>
                  <td>{t(STATUS[p.status] ?? "seller.status.DRAFT")}</td>
                  <td>{p.condition_grade_code === null || p.condition_grade_code === undefined ? "" : t(GRADE[p.condition_grade_code] ?? "seller.grade.new_with_tags")}</td>
                  <td>{p.sku_count}</td>
                  <td>{formatDate(new Date(p.updated_at), resolved.locale, { style: "medium" })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {page.data.next_cursor === null ? null : (
            <p>
              <Link className="btnLink" href={`${base}/products?cursor=${page.data.next_cursor}`}>
                {t("seller.products.next")}
              </Link>
            </p>
          )}
        </>
      ) : null}
    </PageFrame>
  );
}
