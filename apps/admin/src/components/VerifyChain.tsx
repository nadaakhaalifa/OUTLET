"use client";

import { useState } from "react";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { adminCall } from "../client/admin-api";

/** Calls GET /admin/audit-log/verify. A missing route is reported as such: never a made-up "intact". */
export function VerifyChain({ locale, market }: { locale: Locale; market: string }) {
  const t = createTranslator(locale);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<MessageKey>("admin.audit.verify.notRun");
  const run = async () => {
    setBusy(true);
    const r = await adminCall(market, "audit-log/verify", { method: "GET" });
    setBusy(false);
    if (r.status === 404 || r.status === 405 || r.status === 503) { setState("admin.audit.verify.unavailable"); return; }
    if (!r.ok) { setState("admin.error.generic"); return; }
    const valid = typeof r.data === "object" && r.data !== null ? (r.data as { ok?: unknown }).ok : undefined;
    setState(valid === true ? "admin.audit.verify.ok" : valid === false ? "admin.audit.verify.broken" : "admin.error.generic");
  };
  return (
    <section aria-labelledby="chain-h" className="card">
      <h2 id="chain-h" className="panelTitle">{t("admin.audit.verify.title")}</h2>
      <button type="button" className="btn btnSecondary" onClick={() => void run()} disabled={busy}>{busy ? t("admin.audit.verify.running") : t("admin.audit.verify.run")}</button>
      <p role="status" data-testid="chain-status" className={state === "admin.audit.verify.broken" ? "error" : "hint"}>{t(state)}</p>
    </section>
  );
}
