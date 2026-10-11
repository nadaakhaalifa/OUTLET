import { ActionForm } from "../../components/ActionForm";
import { Pager } from "../../components/Pager";
import { ScreenFrame } from "../../components/ScreenFrame";
import { inspectReturnAction } from "../actions";
import { loadReturns } from "../../loaders";
import { pageCtx } from "../../page-context";

export default async function ReturnsPage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const { cursor } = await searchParams;
  const { ctx, t, locale } = await pageCtx();
  const state = await loadReturns(ctx, cursor);
  return (
    <section aria-labelledby="ret-h">
      <h2 id="ret-h">{t("returns.title")}</h2>
      <p className="hint">{t("returns.silence")}</p>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <>
            <div className="tablewrap">
              <table>
                <caption className="vh">{t("returns.title")}</caption>
                <thead>
                  <tr>
                    <th scope="col">#</th>
                    <th scope="col">{t("returns.rejectionReason")}</th>
                    <th scope="col">{t("catalog.col.status")}</th>
                    <th scope="col"><span className="vh">{t("returns.inspect")}</span></th>
                  </tr>
                </thead>
                <tbody>
                  {vm.rows.map((r) => (
                    <tr key={r.id}>
                      <th scope="row" dir="ltr">{r.id.slice(0, 8)}</th>
                      <td>{t(r.reasonKey)}{r.due === null ? null : <><br /><span className="hint">{t("returns.dueBy", { time: r.due })}</span></>}</td>
                      <td dir="ltr">{r.status}</td>
                      <td>
                        {r.inspectable ? (
                          <>
                            <ActionForm action={inspectReturnAction} locale={locale} label={t("returns.approve")} hidden={{ id: r.id, decision: "approve" }} variant="primary" />
                            <ActionForm action={inspectReturnAction} locale={locale} label={t("returns.reject")} hidden={{ id: r.id, decision: "reject", reason: "other" }} variant="danger" />
                          </>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager nextCursor={vm.nextCursor} href="/returns" t={t} />
          </>
        )}
      </ScreenFrame>
    </section>
  );
}
