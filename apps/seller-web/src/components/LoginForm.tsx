"use client";
import { useActionState, useState } from "react";
import { beginPasskeyAction, completePasskeyAction, verifyTotpAction, type ActionResult } from "../app/actions";
import { createTranslator, type MessageKey, type Locale } from "../i18n";

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};
const bytesToB64url = (b: ArrayBuffer): string => {
  let s = "";
  new Uint8Array(b).forEach((x) => {
    s += String.fromCharCode(x);
  });
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export function LoginForm({ locale }: { locale: Locale }) {
  const t = createTranslator(locale);
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [totp, runTotp, totpPending] = useActionState<ActionResult | null, FormData>(verifyTotpAction, null);

  async function passkey(): Promise<void> {
    setError(null);
    if (typeof window === "undefined" || window.PublicKeyCredential === undefined) {
      setError("login.unsupported");
      return;
    }
    setBusy(true);
    try {
      const begin = await beginPasskeyAction();
      if (!begin.ok) {
        setError(begin.messageKey);
        return;
      }
      const cred = await navigator.credentials.get({
        publicKey: { challenge: b64urlToBytes(begin.challenge), rpId: begin.rpId, userVerification: "required", timeout: 60_000 },
      });
      if (!(cred instanceof PublicKeyCredential) || !(cred.response instanceof AuthenticatorAssertionResponse)) {
        setError("login.failed");
        return;
      }
      const r = cred.response;
      const done = await completePasskeyAction(begin.challengeId, {
        id: cred.id,
        rawId: bytesToB64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: bytesToB64url(r.clientDataJSON),
          authenticatorData: bytesToB64url(r.authenticatorData),
          signature: bytesToB64url(r.signature),
          ...(r.userHandle === null ? {} : { userHandle: bytesToB64url(r.userHandle) }),
        },
      });
      if (done.ok) window.location.assign("/dashboard");
      else setError(done.messageKey);
    } catch {
      setError("login.failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <p>{t("login.body")}</p>
      <button type="button" className="btn primary" onClick={() => void passkey()} disabled={busy} aria-busy={busy}>
        {t("login.passkey")}
      </button>
      {error === null ? null : <p role="alert" className="err">{t(error)}</p>}
      <form action={runTotp} className="card">
        <div className="field">
          <label htmlFor="totp">{t("login.totpLabel")}</label>
          <input id="totp" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
        </div>
        <button type="submit" className="btn" disabled={totpPending}>{t("login.totpSubmit")}</button>
        {totp !== null && !totp.ok ? <p role="alert" className="err">{t(totp.messageKey)}</p> : null}
      </form>
    </div>
  );
}
