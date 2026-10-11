import type { ReactNode } from "react";
import type { ApiError } from "../api/client";
import type { ConsoleContext } from "../server/console";
import { errorState } from "../view-models/common";
import type { Countdown } from "../lib/format";
import type { Translator, MessageKey } from "../i18n";

export function clockText(c: Countdown, t: Translator): string {
  const key: MessageKey = c.overdue
    ? c.unit === "days" ? "clock.over.days" : c.unit === "hours" ? "clock.over.hours" : "clock.over.minutes"
    : c.unit === "days" ? "clock.left.days" : c.unit === "hours" ? "clock.left.hours" : "clock.left.minutes";
  return t(key, { n: c.amount });
}

const FLASH_KEYS: Readonly<Record<string, MessageKey>> = {
  ok: "flash.ok",
  forbidden: "state.forbidden",
  not_found: "state.notFound",
  conflict: "state.conflict",
  validation: "flash.validation",
  rate_limited: "state.rateLimited",
  unauthorized: "state.sessionExpired",
  unavailable: "state.unavailable",
  offline: "state.offline",
  server: "state.error",
  contract: "state.contract",
  not_configured: "state.notConfigured",
};

export function Flash({ code, t }: { code: string | undefined; t: Translator }) {
  if (code === undefined) return null;
  const key = FLASH_KEYS[code];
  if (key === undefined) return null;
  return (
    <p role={code === "ok" ? "status" : "alert"} className={code === "ok" ? "notice ok" : "notice error"}>
      {t(key)}
    </p>
  );
}

export function PageHeader({ title, intro }: { title: string; intro?: string }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {intro === undefined ? null : <p className="muted">{intro}</p>}
    </header>
  );
}

/** Renders an honest error state for an API failure. `forbidden` explains the role gap, nothing more. */
export function ErrorBlock({ error, c }: { error: ApiError; c: ConsoleContext }) {
  const s = errorState(error);
  if (s.kind !== "error") return null;
  return (
    <div role="alert" className="notice error">
      <p>{c.t(s.messageKey)}</p>
      {s.requestId === null ? null : <p className="muted" dir="ltr">{c.t("state.errorDetail", { requestId: s.requestId })}</p>}
    </div>
  );
}

export function Empty({ t, messageKey = "state.empty" }: { t: Translator; messageKey?: MessageKey }) {
  return <p className="muted empty">{t(messageKey)}</p>;
}

export function Badge({ tone, children }: { tone: "ok" | "warn" | "bad" | "neutral"; children: ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function WritesDisabledNote({ c }: { c: ConsoleContext }) {
  if (c.posture.sensitiveWritesEnabled) return null;
  return <p className="muted">{c.t("posture.writesDisabled")}</p>;
}
