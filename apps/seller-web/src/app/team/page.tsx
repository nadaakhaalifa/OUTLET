import { ActionForm } from "../../components/ActionForm";
import { ScreenFrame } from "../../components/ScreenFrame";
import { inviteMemberAction, removeMemberAction } from "../actions";
import { loadTeam } from "../../loaders";
import { pageCtx } from "../../page-context";

const ROLES = ["manager", "fulfilment", "catalog", "finance"] as const;

export default async function TeamPage() {
  const { ctx, t, locale } = await pageCtx();
  const state = await loadTeam(ctx);
  return (
    <section aria-labelledby="team-h">
      <h2 id="team-h">{t("team.title")}</h2>
      <p className="hint">{t("team.mfaWarning")}</p>
      <ActionForm action={inviteMemberAction} locale={locale} label={t("team.invite")} hidden={{}} variant="primary">
        <div className="field">
          <label htmlFor="inv-email">{t("team.email")}</label>
          <input id="inv-email" name="email" type="email" autoComplete="off" required dir="ltr" />
        </div>
        <div className="field">
          <label htmlFor="inv-role">{t("team.role")}</label>
          <select id="inv-role" name="role" defaultValue="fulfilment">
            {ROLES.map((r) => <option key={r} value={r}>{t(`team.role.${r}`)}</option>)}
          </select>
        </div>
      </ActionForm>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <div className="tablewrap"><table>
            <caption className="vh">{t("team.title")}</caption>
            <thead>
              <tr><th scope="col">{t("team.email")}</th><th scope="col">{t("team.role")}</th><th scope="col">{t("team.mfa")}</th><th scope="col">{t("catalog.col.status")}</th><th scope="col"><span className="vh">{t("team.remove")}</span></th></tr>
            </thead>
            <tbody>
              {vm.rows.map((m) => (
                <tr key={m.id}>
                  <th scope="row">{m.name}{m.emailMasked === null ? null : <><br /><span dir="ltr" className="hint">{m.emailMasked}</span></>}</th>
                  <td>{t(m.roleKey)}</td>
                  <td><span className={m.mfaMissing ? "pill warn" : "pill"}>{t(m.mfaKey)}</span></td>
                  <td>{t(m.statusKey)}</td>
                  <td>{m.removable ? <ActionForm action={removeMemberAction} locale={locale} label={t("team.remove")} hidden={{ id: m.id }} variant="danger" /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </ScreenFrame>
    </section>
  );
}
