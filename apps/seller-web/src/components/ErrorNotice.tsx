import type { Locale, MessageKey } from "../i18n";
import { createTranslator } from "../i18n";

/** Structural subset of the API error (components never import the API client). */
export interface NoticeError {
  readonly kind: string;
  readonly requestId?: string;
}

const KEY: Readonly<Record<string, MessageKey>> = {
  unauthorized: "state.sessionExpired",
  forbidden: "state.forbidden",
  not_found: "state.notFound",
  rate_limited: "state.rateLimited",
  offline: "state.offline",
  contract: "state.contract",
  not_configured: "state.notConfigured",
};

/** One honest, announced state for every failed load: 401 offers re-auth, 403 explains, offline and 5xx offer retry. */
export function ErrorNotice({ error, locale, kind }: { error?: NoticeError; locale: Locale; kind?: "not_configured" | "forbidden" | "no_store" }) {
  const t = createTranslator(locale);
  const k = kind ?? error?.kind ?? "server";
  const key: MessageKey = kind === "no_store" ? "ob.state.noStore" : KEY[k] ?? "state.error";
  return (
    <div role="alert" className="zm-alert">
      <p>{t(key)}</p>
      {error?.requestId === undefined ? null : <p className="zm-hint">{t("state.errorDetail", { requestId: error.requestId })}</p>}
      <div className="zm-actions">
        {k === "unauthorized" ? <a className="zm-btn primary" href="/login">{t("ob.auth.signIn")}</a> : null}
        {k === "offline" || k === "server" || k === "rate_limited" || k === "contract" ? <a className="zm-btn" href="">{t("common.retry")}</a> : null}
        {kind === "no_store" ? <a className="zm-btn" href="/apply">{t("ob.state.applyCta")}</a> : null}
      </div>
    </div>
  );
}
