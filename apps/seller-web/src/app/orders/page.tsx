import { Countdown } from "../../components/Countdown";
import { OrderActions } from "../../components/OrderActions";
import { Pager } from "../../components/Pager";
import { ScreenFrame } from "../../components/ScreenFrame";
import { loadOrders } from "../../loaders";
import { pageCtx } from "../../page-context";

export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  const { ctx, t, locale } = await pageCtx();
  const state = await loadOrders(ctx, cursor);
  return (
    <section aria-labelledby="orders-h">
      <h2 id="orders-h">{t("orders.title")}</h2>
      <ScreenFrame state={state} t={t}>
        {(vm, serverNowMs) => (
          <>
            <div className="tablewrap">
              <table>
                <caption className="vh">{t("orders.title")}</caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{t("catalog.col.status")}</th>
                    <th scope="col">{t("catalog.col.title")}</th>
                    <th scope="col">{t("finance.col.amount")}</th>
                    <th scope="col">{t("orders.col.deadline")}</th>
                    <th scope="col"><span className="vh">{t("orders.accept")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {vm.rows.map((r) => (
                    <tr key={r.id}>
                      <th scope="row" dir="ltr">{r.id.slice(0, 8)}<br /><span className="hint">{r.createdAt}</span></th>
                      <td>
                        {t(r.statusKey)}<br />
                        <span className="pill">{t(r.paymentKey)}</span>
                        {r.governorate === null ? null : <span className="hint"> {t("orders.buyerGovernorate")}: {r.governorate}</span>}
                      </td>
                      <td>
                        <ul>{r.lines.map((l, i) => <li key={i}>{l.title}{l.size === null ? "" : ` (${l.size})`} x {l.qty}</li>)}</ul>
                      </td>
                      <td>{r.subtotal}{r.net === null ? null : <><br /><span className="hint">{t("orders.net")}: {r.net}</span></>}</td>
                      <td>{r.deadlineIso === null ? null : <Countdown deadlineIso={r.deadlineIso} serverNowMs={serverNowMs} locale={locale} />}</td>
                      <td><OrderActions id={r.id} actions={r.actions} locale={locale} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager nextCursor={vm.nextCursor} href="/orders" t={t} />
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
