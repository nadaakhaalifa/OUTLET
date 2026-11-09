"use client";

import { useState } from "react";
import { createTranslator, type Locale } from "@outlet/i18n";
import { uuidv7 } from "../lib/uuid7";
import { adminCall } from "../client/admin-api";

export function LogoutButton({ locale, market }: { locale: Locale; market: string }) {
  const t = createTranslator(locale);
  const [busy, setBusy] = useState(false);
  const out = async () => {
    setBusy(true);
    await adminCall(market, "auth/logout", { method: "POST", idempotencyKey: uuidv7() });
    window.location.assign(`/${market}-${document.documentElement.lang === "en" ? "en" : "ar"}/login`);
  };
  return <button type="button" className="btn btnSecondary" onClick={() => void out()} disabled={busy}>{t("admin.topbar.logout")}</button>;
}
