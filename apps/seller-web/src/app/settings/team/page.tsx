import { DynamicForm } from "../../../components/DynamicForm";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { formatDateTime } from "../../../lib/format";
import { settingsCtx } from "../../../page-settings";
import { INVITABLE_ROLES, teamRows } from "../../../view-models/store-settings";
import { inviteAction, teamMutationAction } from "../../actions-onboarding";

export default async function TeamSettingsPage() {
  const c = await settingsCtx();
  if (!c.ok) return c.node;
  const { api, scope, t, locale } = c;
  const r = await api.team(scope.storeId);
  if (!r.ok) return <ErrorNotice error={r.error} locale={locale} />;
  const isOwner = scope.role === "owner";
  const rows = teamRows(r.value.data, scope.userId, scope.role);
  const invites = r.value.data.invites.filter((i) => i.status === "PENDING");
  return (
    <section aria-labelledby="tm-h">
      <h1 id="tm-h">{t("ob.team.title")}</h1>
      <p className="zm-lead">{t("ob.team.lead")}</p>
      {isOwner ? null : <p role="status" className="zm-notice">{t("ob.team.ownerOnly")}</p>}
      <div className="tablewrap">
        <table className="zm-table">
          <caption className="vh">{t("ob.team.members")}</caption>
          <thead><tr><th scope="col">{t("ob.team.member")}</th><th scope="col">{t("ob.team.role")}</th><th scope="col"><span className="vh">{t("ob.team.actions")}</span></th></tr></thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.userId}>
                <th scope="row"><span dir="ltr">{m.phoneMasked ?? "—"}</span>{m.isSelf ? <span className="zm-tag"> · {t("ob.team.you")}</span> : null}</th>
                <td>
                  {isOwner && m.canChangeRole ? (
                    <DynamicForm action={teamMutationAction} locale={locale} hidden={{ op: "role", target: m.userId }} submitLabel={t("ob.team.changeRole")} variant="quiet" nextPath="/settings/team"
                      fields={[{ name: "role", label: t("ob.team.role"), type: "select", value: m.role, options: [{ value: "owner", label: t("ob.role.owner") }, ...INVITABLE_ROLES.map((x) => ({ value: x, label: t(`ob.role.${x}` as const) }))] }]} />
                  ) : <>{t(`ob.role.${m.role}` as const)}{m.protectedReason === "last_owner" ? <span className="zm-hint"> · {t("ob.team.lastOwner")}</span> : null}</>}
                </td>
                <td>
                  {isOwner && m.canRemove && !m.isSelf ? (
                    <DynamicForm action={teamMutationAction} locale={locale} hidden={{ op: "remove", target: m.userId }} submitLabel={t("ob.team.remove")} variant="danger" fields={[]} nextPath="/settings/team" />
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {invites.length === 0 ? null : (
        <>
          <h2>{t("ob.team.pending")}</h2>
          <ul className="zm-list">
            {invites.map((i) => (
              <li key={i.id}>
                <span dir="ltr">{i.phone_masked}</span> · {t(`ob.role.${i.role}` as const)}
                {i.expires_at === null ? null : <span className="zm-hint"> · {t("ob.team.expires", { date: formatDateTime(i.expires_at, locale) })}</span>}
                {isOwner ? <DynamicForm action={teamMutationAction} locale={locale} hidden={{ op: "revoke", target: i.id }} submitLabel={t("ob.team.revoke")} variant="quiet" fields={[]} nextPath="/settings/team" /> : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {isOwner ? (
        <>
          <h2>{t("ob.team.invite")}</h2>
          <DynamicForm action={inviteAction} locale={locale} submitLabel={t("ob.team.sendInvite")} nextPath="/settings/team"
            fields={[
              { name: "phone", label: t("ob.auth.phone"), type: "tel", dir: "ltr", inputMode: "tel", required: true, autoComplete: "off", hint: t("ob.team.inviteHint") },
              { name: "role", label: t("ob.team.role"), type: "select", required: true, options: INVITABLE_ROLES.map((x) => ({ value: x, label: t(`ob.role.${x}` as const) })) },
            ]} />
        </>
      ) : null}
    </section>
  );
}
