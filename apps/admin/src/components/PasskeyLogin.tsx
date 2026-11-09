"use client";

import { useState } from "react";
import { createTranslator, type Locale, type MessageKey } from "@outlet/i18n";
import { uuidv7 } from "../lib/uuid7";
import { adminCall } from "../client/admin-api";
import { problemKey } from "../lib/problem";
import { assertionToJson, requestOptionsFromJson } from "../lib/webauthn";

const INSTALL_KEY = "admin_install_id";

function installId(): string {
  try {
    const existing = window.localStorage.getItem(INSTALL_KEY);
    if (existing !== null && existing !== "") return existing;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(INSTALL_KEY, fresh);
    return fresh;
  } catch {
    return crypto.randomUUID();
  }
}

/** Passkey-only sign-in. The TOTP fallback is shown disabled (no code path) until the API offers it. */
export function PasskeyLogin({ locale, market, home }: { locale: Locale; market: string; home: string }) {
  const t = createTranslator(locale);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  const signIn = async () => {
    setError(null);
    if (typeof window.PublicKeyCredential === "undefined" || !("credentials" in navigator)) { setError("admin.login.error.unsupported"); return; }
    setBusy(true);
    try {
      const device = { install_id: installId(), platform: "web", ua_family: "browser" };
      const opts = await adminCall(market, "auth/passkey/options", { method: "POST", idempotencyKey: uuidv7(), body: { purpose: "sign_in", device } });
      const challenge = typeof opts.data === "object" && opts.data !== null ? (opts.data as { challenge_id?: unknown; public_key?: unknown }) : {};
      const publicKey = requestOptionsFromJson(challenge.public_key);
      if (!opts.ok || typeof challenge.challenge_id !== "string" || publicKey === null) { setError(opts.ok ? "admin.login.error.failed" : problemKey(opts.code, opts.status)); return; }
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.get({ publicKey });
      } catch {
        setError("admin.login.error.cancelled"); return;
      }
      if (credential === null) { setError("admin.login.error.cancelled"); return; }
      const verified = await adminCall(market, "auth/passkey/verify", { method: "POST", idempotencyKey: uuidv7(), body: { challenge_id: challenge.challenge_id, credential: assertionToJson(credential as PublicKeyCredential), device } });
      if (!verified.ok) { setError("admin.login.error.failed"); return; }
      window.location.assign(home);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stepForm">
      <button type="button" className="btn btnPrimary" onClick={() => void signIn()} disabled={busy}>{busy ? t("admin.login.working") : t("admin.login.passkey")}</button>
      {error !== null ? <p className="error" role="alert">{t(error)}</p> : null}
      <div className="fallback">
        <button type="button" className="btn btnGhost" disabled aria-describedby="totp-note">{t("admin.login.totp")}</button>
        <p id="totp-note" className="hint">{t("admin.login.totpSoon")}</p>
      </div>
    </div>
  );
}
