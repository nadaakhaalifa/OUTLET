import { LoginForm } from "../../components/LoginForm";
import { getContext } from "../../server-context";

export default async function LoginPage() {
  const { t, locale, api } = await getContext();
  return (
    <section aria-labelledby="login-h" className="card">
      <h2 id="login-h">{t("login.title")}</h2>
      {api === null ? <p role="alert" className="banner error">{t("state.notConfigured")}</p> : <LoginForm locale={locale} />}
    </section>
  );
}
