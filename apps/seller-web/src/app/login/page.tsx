import { Monogram } from "../../components/Identity";
import { SellerAuthFlow } from "../../components/SellerAuthFlow";
import { getOnboarding } from "../../onboarding-context";
import { safeNextPath } from "../../view-models/auth-flow";
import { passkeyFinishAction, passkeyOptionsAction, requestOtpAction, totpEnrolAction, totpFinishAction, verifyOtpAction } from "../actions-onboarding";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { t, locale, api } = await getOnboarding();
  const sp = await searchParams;
  const nextRaw = typeof sp.next === "string" ? sp.next : null;
  const stepUp = sp.stepup === "1";
  return (
    <section aria-labelledby="login-h">
      <div className="login-mark"><Monogram size={44} /></div>
      <h1 id="login-h">{stepUp ? t("ob.stepup.title") : t("ob.auth.title")}</h1>
      <p className="zm-lead">{t("ob.auth.lead")}</p>
      {api === null ? (
        <p role="alert" className="zm-alert">{t("state.notConfigured")}</p>
      ) : (
        <SellerAuthFlow
          locale={locale}
          next={nextRaw === null ? null : safeNextPath(nextRaw)}
          stepUp={stepUp}
          actions={{
            requestOtp: requestOtpAction, verifyOtp: verifyOtpAction, passkeyOptions: passkeyOptionsAction,
            passkeyFinish: passkeyFinishAction, totpEnrol: totpEnrolAction, totpFinish: totpFinishAction,
          }}
        />
      )}
    </section>
  );
}
