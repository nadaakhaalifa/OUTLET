import { DynamicForm } from "../../../components/DynamicForm";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { MediaSlot } from "../../../components/Uploads";
import { canWriteSettings, settingsCtx } from "../../../page-settings";
import { profileValues } from "../../../view-models/store-settings";
import { confirmMediaUploadAction, createMediaUploadAction, saveProfileAction } from "../../actions-onboarding";

export default async function ProfilePage() {
  const c = await settingsCtx();
  if (!c.ok) return c.node;
  const { api, scope, t, locale } = c;
  const r = await api.profile(scope.storeId);
  if (!r.ok) return <ErrorNotice error={r.error} locale={locale} />;
  const p = r.value.data;
  const v = profileValues(p);
  const writable = canWriteSettings(scope.role);
  return (
    <section aria-labelledby="pf-h">
      <h1 id="pf-h">{t("ob.profile.title")}</h1>
      <p className="zm-lead">{t("ob.profile.lead")}</p>
      {writable ? null : <p role="status" className="zm-notice">{t("ob.set.readOnly")}</p>}
      <DynamicForm
        action={saveProfileAction} locale={locale} hidden={{ section: "profile", expectedVersion: String(p.version) }}
        submitLabel={t("common.save")} nextPath="/settings/profile" disabled={!writable}
        fields={[
          { name: "nameAr", label: t("ob.profile.nameAr"), type: "text", value: v.nameAr, required: true, maxLength: 200, dir: "auto", hint: t("ob.profile.nameArHint"), disabled: !writable },
          { name: "nameEn", label: t("ob.profile.nameEn"), type: "text", value: v.nameEn, maxLength: 200, dir: "ltr", disabled: !writable },
          { name: "descriptionAr", label: t("ob.profile.descAr"), type: "textarea", value: v.descriptionAr, maxLength: 4000, disabled: !writable },
          { name: "descriptionEn", label: t("ob.profile.descEn"), type: "textarea", value: v.descriptionEn, maxLength: 4000, disabled: !writable },
        ]}
      />
      <h2>{t("ob.profile.media")}</h2>
      {writable ? (
        <>
          <MediaSlot slot="logo" label={t("ob.profile.logo")} hint={t("ob.profile.logoHint")} statusText={p.logo_key ? t("ob.profile.mediaSet") : t("ob.profile.mediaMissing")} locale={locale} createUpload={createMediaUploadAction} confirmUpload={confirmMediaUploadAction} />
          <MediaSlot slot="cover" label={t("ob.profile.cover")} hint={t("ob.profile.coverHint")} statusText={p.cover_key ? t("ob.profile.mediaSet") : t("ob.profile.mediaMissing")} locale={locale} createUpload={createMediaUploadAction} confirmUpload={confirmMediaUploadAction} />
        </>
      ) : <p className="zm-hint">{t("ob.set.readOnly")}</p>}
    </section>
  );
}
