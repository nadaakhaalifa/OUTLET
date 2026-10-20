import type { ReactNode } from "react";
import type { Translator } from "../i18n";
import type { ScreenState } from "../view-models/screen-state";

/**
 * Renders the non-data states of a ScreenState (loading, offline, not configured, empty, error).
 * For "ready" it renders children. role=status / role=alert so assistive tech announces changes.
 */
export function ScreenFrame<T>({ state, t, children }: { state: ScreenState<T>; t: Translator; children: (data: T, serverNowMs: number | null) => ReactNode }) {
  switch (state.kind) {
    case "loading":
      return <p role="status">{t("state.loading")}</p>;
    case "offline":
      return <p role="alert" className="banner error">{t("state.offline")}</p>;
    case "not_configured":
      return <p role="alert" className="banner error">{t("state.notConfigured")}</p>;
    case "empty":
      return <p role="status" className="banner">{t("state.empty")}</p>;
    case "error":
      return (
        <div role="alert" className="banner error">
          <p>{t(state.messageKey)}</p>
          {state.requestId === undefined ? null : <p className="hint">{t("state.errorDetail", { requestId: state.requestId })}</p>}
          {state.signIn ? <a className="btn" href="/login">{t("login.passkey")}</a> : null}
          {state.retryable ? <a className="btn" href="">{t("common.retry")}</a> : null}
        </div>
      );
    case "ready":
      return <>{children(state.data, state.serverNowMs)}</>;
  }
}
