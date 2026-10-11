import { ScreenFrame } from "../../components/ScreenFrame";
import { loadHub } from "../../loaders-phase2";
import { pageCtx } from "../../page-context";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function HubPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ctx, t } = await pageCtx();
  const raw = (await searchParams).og;
  const og = typeof raw === "string" ? raw.trim() : "";
  const invalid = og !== "" && !UUID.test(og);
  const state = og !== "" && !invalid ? await loadHub(ctx, og) : null;
  return (
    <section aria-labelledby="hub-h">
      <h2 id="hub-h">{t("hub.title")}</h2>
      <p className="hint">{t("hub.intro")}</p>
      <p className="hint">{t("hub.scopeNote")}</p>
      <form method="get" className="row">
        <div className="field">
          <label htmlFor="hub-og">{t("hub.lookup")}</label>
          <input id="hub-og" name="og" defaultValue={og} dir="ltr" autoComplete="off" aria-invalid={invalid} aria-describedby={invalid ? "hub-err" : undefined} />
        </div>
        <button className="btn" type="submit">{t("hub.lookup.submit")}</button>
      </form>
      {invalid ? <p id="hub-err" role="alert" className="err">{t("hub.err.id")}</p> : null}
      {state === null ? (invalid ? null : <p className="hint">{t("hub.none")}</p>) : (
        <ScreenFrame state={state} t={t}>
          {(vm) => (
            <>
              <dl className="tiles">
                <div className="tile"><dt>{t("hub.fee")}</dt><dd>{vm.deliveryFee}</dd></div>
                <div className="tile"><dt>{t("hub.waiting")}</dt><dd>{vm.waiting}</dd></div>
              </dl>
              <h3>{t("hub.parcels")}</h3>
              <div className="tablewrap"><table>
                <caption className="vh">{t("hub.parcels")}</caption>
                <thead><tr>
                  <th scope="col">{t("hub.col.status")}</th><th scope="col">{t("hub.col.awb")}</th><th scope="col">{t("hub.col.courier")}</th>
                  <th scope="col">{t("hub.col.orders")}</th><th scope="col">{t("hub.col.fee")}</th>
                </tr></thead>
                <tbody>{vm.parcels.map((p) => (
                  <tr key={p.id}>
                    <th scope="row">{t(p.statusKey)}</th><td dir="ltr">{p.awb ?? <span className="hint">{t("p2.noValue")}</span>}</td>
                    <td>{p.courier ?? <span className="hint">{t("p2.noValue")}</span>}</td><td>{p.orders}</td><td>{p.fee}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            </>
          )}
        </ScreenFrame>
      )}
    </section>
  );
}
