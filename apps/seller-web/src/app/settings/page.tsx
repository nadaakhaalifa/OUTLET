import { ScreenFrame } from "../../components/ScreenFrame";
import { loadSettings } from "../../loaders";
import { pageCtx } from "../../page-context";
import { setLocaleAction, signOutAction } from "../actions";

export default async function SettingsPage() {
  const { ctx, t } = await pageCtx();
  const state = await loadSettings(ctx);
  return (
    <section aria-labelledby="set-h">
      <h2 id="set-h">{t("settings.title")}</h2>
      <ScreenFrame state={state} t={t}>
        {(vm) => (
          <dl className="card">
            <dt>{t("settings.store")}</dt><dd>{vm.name}</dd>
            <dt>{t("settings.kyc")}</dt><dd>{t(vm.kycKey)}</dd>
            <dt>{t("settings.legalIdentity")}</dt>
            <dd>
              {vm.legal.name}
              {vm.legal.register === null ? null : <><br /><span dir="ltr">{vm.legal.register}</span></>}
              {vm.legal.tax === null ? null : <><br /><span dir="ltr">{vm.legal.tax}</span></>}
              {vm.legal.governorate === null ? null : <><br />{vm.legal.governorate}</>}
            </dd>
            {vm.threshold === null ? null : <><dt>{t("settings.threshold")}</dt><dd>{vm.threshold}</dd></>}
            {vm.acceptHours === null ? null : <><dt>{t("settings.acceptSla")}</dt><dd>{vm.acceptHours}</dd></>}
            {vm.dispatchHours === null ? null : <><dt>{t("settings.dispatchSla")}</dt><dd>{vm.dispatchHours}</dd></>}
            <dt>{t("settings.vacation")}</dt><dd>{vm.vacation ? t("settings.vacation") : t("common.none")}</dd>
            {vm.health === null ? null : <><dt>{t("settings.health")}</dt><dd>{vm.health}</dd></>}
          </dl>
        )}
      </ScreenFrame>
      <div className="row">
        <form action={setLocaleAction}>
          <input type="hidden" name="locale" value={t("common.language") === "English" ? "en" : "ar"} />
          <button type="submit" className="btn">{t("common.language")}</button>
        </form>
        <form action={signOutAction}>
          <button type="submit" className="btn">{t("common.signOut")}</button>
        </form>
      </div>
    </section>
  );
}
