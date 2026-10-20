import Link from "next/link";
import { Pager } from "../../components/Pager";
import { ScreenFrame } from "../../components/ScreenFrame";
import { loadCatalog } from "../../loaders";
import { pageCtx } from "../../page-context";

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  const { ctx, t } = await pageCtx();
  const state = await loadCatalog(ctx, cursor);
  return (
    <section aria-labelledby="cat-h">
      <h2 id="cat-h">{t("catalog.title")}</h2>
      <div className="toolbar">
        <Link className="btn primary" href="/catalog/new">{t("catalog.new")}</Link>
        <Link className="btn" href="/catalog/import">{t("catalog.import")}</Link>
      </div>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <>
            <div className="tablewrap">
              <table>
                <caption className="vh">{t("catalog.title")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("catalog.col.title")}</th>
                    <th scope="col">{t("catalog.col.status")}</th>
                    <th scope="col">{t("catalog.col.department")}</th>
                    <th scope="col">{t("catalog.col.price")}</th>
                    <th scope="col">{t("catalog.col.stock")}</th>
                    <th scope="col">{t("catalog.col.claim")}</th>
                  </tr>
                </thead>
                <tbody>
                  {vm.rows.map((r) => (
                    <tr key={r.id}>
                      <th scope="row">{r.title}</th>
                      <td>{t(r.statusKey)}</td>
                      <td>{t(r.departmentKey)}</td>
                      <td>{r.price}</td>
                      <td>{r.stock}</td>
                      <td>{t(r.claimKey)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager nextCursor={vm.nextCursor} href="/catalog" t={t} />
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
