import { Monogram } from "../../components/identity-mark";
import { PasskeyLogin } from "../../components/passkey-login";
import { createTranslator } from "../../i18n";
import { readLocale } from "../../server/console";

export default async function LoginPage() {
  const t = createTranslator(await readLocale());
  return (
    <main>
      <div className="login-mark"><Monogram size={48} /></div>
      <h1>{t("app.name")}</h1>
      <p className="muted">{t("login.passkeyOnly")}</p>
      <PasskeyLogin
        labels={{
          signIn: t("login.signIn"), working: t("common.loading"), unsupported: t("login.unsupported"),
          failed: t("login.failed"), cancelled: t("login.cancelled"),
        }}
      />
    </main>
  );
}
