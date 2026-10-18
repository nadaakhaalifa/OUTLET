import { DynamicForm, type FieldSpec } from "../../../components/DynamicForm";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { canWriteSettings, settingsCtx } from "../../../page-settings";
import { NOTIFICATION_CHANNELS, NOTIFICATION_EVENTS, prefCells } from "../../../view-models/store-settings";
import { savePrefsAction } from "../../actions-onboarding";

export default async function NotificationsPage() {
  const c = await settingsCtx();
  if (!c.ok) return c.node;
  const { api, scope, t, locale } = c;
  const r = await api.notificationPrefs(scope.storeId);
  if (!r.ok) return <ErrorNotice error={r.error} locale={locale} />;
  const cells = prefCells(r.value.data);
  const writable = canWriteSettings(scope.role);
  const fields: FieldSpec[] = NOTIFICATION_EVENTS.map((e) => {
    const mine = cells.filter((x) => x.event === e);
    return {
      name: "pref",
      label: t(`ob.notif.event.${e}` as const),
      type: "checks",
      disabled: !writable,
      values: mine.filter((x) => x.on).map((x) => `${e}:${x.channel}`),
      options: NOTIFICATION_CHANNELS.map((ch) => {
        const cell = mine.find((x) => x.channel === ch);
        return { value: `${e}:${ch}`, label: t(`ob.notif.channel.${ch}` as const), locked: cell?.locked === true };
      }),
    };
  });
  return (
    <section aria-labelledby="nt-h">
      <h1 id="nt-h">{t("ob.notif.title")}</h1>
      <p className="zm-lead">{t("ob.notif.lead")}</p>
      {writable ? null : <p role="status" className="zm-notice">{t("ob.set.readOnly")}</p>}
      <DynamicForm action={savePrefsAction} locale={locale} fields={fields} submitLabel={t("common.save")} nextPath="/settings/notifications" disabled={!writable} />
    </section>
  );
}
