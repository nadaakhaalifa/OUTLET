"use client";
import { useEffect, useRef, useState } from "react";
import type { Out } from "../app/actions-onboarding";
import { createTranslator, type Locale, type MessageKey } from "../i18n";
import {
  canLeaveRecoveryCodes, classifyWebauthnError, formatRecoveryCodes, groupSecret, normalizeCode, normalizePhone, parseOtpauth, resendRemaining,
  safeNextPath, serializeAssertion, serializeAttestation, strongFactorStep, switchMethod, toCreationOptions, toRequestOptions, validateSignUp,
  type AuthStep,
} from "../view-models/auth-flow";
import { QrCode } from "./QrCode";

export interface AuthActions {
  readonly requestOtp: (i: { phone: string; email: string; locale: "ar" | "en"; channel: "sms" | "whatsapp" }) => Promise<Out<{ challengeId: string; expiresIn: number; resendAfter: number }>>;
  readonly verifyOtp: (i: { challengeId: string; code: string }) => Promise<Out<{ nextStep: "enrol_strong_factor" | "assert_strong_factor" }>>;
  readonly passkeyOptions: (mode: "register" | "assert") => Promise<Out<{ challengeId: string; publicKey: Record<string, unknown> }>>;
  readonly passkeyFinish: (i: { mode: "register" | "assert"; challengeId: string; credential: Record<string, unknown>; label?: string }) => Promise<Out<{ redirect: string }>>;
  readonly totpEnrol: () => Promise<Out<{ otpauthUri: string; recoveryCodes: readonly string[] }>>;
  readonly totpFinish: (i: { mode: "confirm" | "assert"; code: string }) => Promise<Out<{ redirect: string }>>;
}

type Stage = { kind: "phone" } | { kind: "otp" } | { kind: "strong"; step: AuthStep; canSwitch: boolean; unsupported: boolean };

export function SellerAuthFlow({ locale, actions, next, stepUp }: { locale: Locale; actions: AuthActions; next: string | null; stepUp: boolean }) {
  const t = createTranslator(locale);
  const [stage, setStage] = useState<Stage>({ kind: "phone" });
  const [challengeId, setChallengeId] = useState("");
  const [resendAfter, setResendAfter] = useState(0);
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(0);
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [channel, setChannel] = useState<"sms" | "whatsapp">("sms");
  const [code, setCode] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [fieldErr, setFieldErr] = useState<Readonly<Record<string, MessageKey>>>({});
  const [totpSetup, setTotpSetup] = useState<{ uri: string; codes: readonly string[] } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);
  const alertRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (sentAt === 0) return undefined;
    const h = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(h);
  }, [sentAt]);
  useEffect(() => {
    if (error !== null) alertRef.current?.focus();
  }, [error]);

  const destination = safeNextPath(next);
  const go = (to: string): void => window.location.assign(safeNextPath(to, destination));
  const passkeySupported = typeof window !== "undefined" && window.isSecureContext && typeof window.PublicKeyCredential !== "undefined";

  async function sendCode(): Promise<void> {
    setError(null);
    const v = validateSignUp(phone, email);
    setFieldErr(v.errors as Record<string, MessageKey>);
    if (v.phone === null || v.email === null) return;
    setBusy(true);
    const r = await actions.requestOtp({ phone: v.phone, email: v.email, locale, channel });
    setBusy(false);
    if (!r.ok) {
      setError(r.messageKey);
      return;
    }
    setChallengeId(r.data.challengeId);
    setResendAfter(r.data.resendAfter);
    setSentAt(Date.now());
    setNow(Date.now());
    setCode("");
    setStage({ kind: "otp" });
  }

  async function verify(): Promise<void> {
    setError(null);
    if (normalizeCode(code) === null) {
      setFieldErr({ code: "ob.auth.err.code" });
      return;
    }
    setFieldErr({});
    setBusy(true);
    const r = await actions.verifyOtp({ challengeId, code });
    setBusy(false);
    if (!r.ok) {
      setError(r.messageKey);
      return;
    }
    const s = strongFactorStep(r.data.nextStep, passkeySupported);
    setStage({ kind: "strong", step: s.step, canSwitch: true, unsupported: s.unsupportedNotice });
  }

  async function passkey(mode: "register" | "assert"): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const opts = await actions.passkeyOptions(mode);
      if (!opts.ok) {
        setError(opts.messageKey);
        return;
      }
      if (mode === "register") {
        const creation = toCreationOptions(opts.data.publicKey);
        if (creation === null) {
          setError("state.contract");
          return;
        }
        const cred = await navigator.credentials.create({ publicKey: creation });
        if (!(cred instanceof PublicKeyCredential) || !(cred.response instanceof AuthenticatorAttestationResponse)) {
          setError("ob.auth.err.passkey");
          return;
        }
        const transports = typeof cred.response.getTransports === "function" ? cred.response.getTransports() : [];
        const done = await actions.passkeyFinish({
          mode, challengeId: opts.data.challengeId,
          credential: serializeAttestation({ id: cred.id, rawId: cred.rawId, type: cred.type, response: { clientDataJSON: cred.response.clientDataJSON, attestationObject: cred.response.attestationObject, transports } }),
        });
        if (done.ok) go(done.data.redirect);
        else setError(done.messageKey);
      } else {
        const request = toRequestOptions(opts.data.publicKey);
        if (request === null) {
          setError("state.contract");
          return;
        }
        const cred = await navigator.credentials.get({ publicKey: request });
        if (!(cred instanceof PublicKeyCredential) || !(cred.response instanceof AuthenticatorAssertionResponse)) {
          setError("ob.auth.err.passkey");
          return;
        }
        const done = await actions.passkeyFinish({
          mode, challengeId: opts.data.challengeId,
          credential: serializeAssertion({ id: cred.id, rawId: cred.rawId, type: cred.type, response: { clientDataJSON: cred.response.clientDataJSON, authenticatorData: cred.response.authenticatorData, signature: cred.response.signature, userHandle: cred.response.userHandle } }),
        });
        if (done.ok) go(done.data.redirect);
        else setError(done.messageKey);
      }
    } catch (e) {
      const kind = classifyWebauthnError(e instanceof DOMException ? e.name : null);
      setError(kind === "cancelled" ? "ob.auth.err.cancelled" : kind === "unsupported" ? "ob.auth.err.unsupported" : "ob.auth.err.passkey");
    } finally {
      setBusy(false);
    }
  }

  async function startTotpEnrol(): Promise<void> {
    setError(null);
    setBusy(true);
    const r = await actions.totpEnrol();
    setBusy(false);
    if (!r.ok) {
      setError(r.messageKey);
      return;
    }
    setTotpSetup({ uri: r.data.otpauthUri, codes: r.data.recoveryCodes });
    setAcknowledged(false);
  }

  async function finishTotp(mode: "confirm" | "assert"): Promise<void> {
    setError(null);
    if (normalizeCode(totpCode) === null) {
      setFieldErr({ totp: "ob.auth.err.code" });
      return;
    }
    setFieldErr({});
    setBusy(true);
    const r = await actions.totpFinish({ mode, code: totpCode });
    setBusy(false);
    if (r.ok) go(r.data.redirect);
    else setError(r.messageKey);
  }

  async function copyCodes(): Promise<void> {
    if (totpSetup === null) return;
    try {
      await navigator.clipboard.writeText(formatRecoveryCodes(totpSetup.codes));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const left = sentAt === 0 ? 0 : resendRemaining(resendAfter, now - sentAt);
  const errorBlock = error === null ? null : <p role="alert" tabIndex={-1} ref={alertRef} className="zm-alert">{t(error)}</p>;

  if (stage.kind === "phone") {
    return (
      <form className="zm-form" noValidate onSubmit={(e) => { e.preventDefault(); void sendCode(); }}>
        {stepUp ? <p className="zm-hint">{t("ob.stepup.body")}</p> : null}
        {errorBlock}
        <div className="zm-field">
          <label htmlFor="sa-phone">{t("ob.auth.phone")}</label>
          <input id="sa-phone" type="tel" inputMode="tel" autoComplete="tel" dir="ltr" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="01XXXXXXXXX" aria-invalid={fieldErr.phone !== undefined} aria-describedby={fieldErr.phone === undefined ? "sa-phone-h" : "sa-phone-h sa-phone-e"} required />
          <p id="sa-phone-h" className="zm-hint">{t("ob.auth.phoneHint")}</p>
          {fieldErr.phone === undefined ? null : <p id="sa-phone-e" className="zm-err">{t(fieldErr.phone)}</p>}
        </div>
        <div className="zm-field">
          <label htmlFor="sa-email">{t("ob.auth.email")}</label>
          <input id="sa-email" type="email" inputMode="email" autoComplete="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} aria-invalid={fieldErr.email !== undefined} aria-describedby={fieldErr.email === undefined ? undefined : "sa-email-e"} required />
          {fieldErr.email === undefined ? null : <p id="sa-email-e" className="zm-err">{t(fieldErr.email)}</p>}
        </div>
        <fieldset className="zm-fieldset">
          <legend>{t("ob.auth.channel")}</legend>
          <div className="zm-check"><input id="sa-ch-sms" type="radio" name="channel" checked={channel === "sms"} onChange={() => setChannel("sms")} /><label htmlFor="sa-ch-sms">{t("ob.auth.channel.sms")}</label></div>
          <div className="zm-check"><input id="sa-ch-wa" type="radio" name="channel" checked={channel === "whatsapp"} onChange={() => setChannel("whatsapp")} /><label htmlFor="sa-ch-wa">{t("ob.auth.channel.whatsapp")}</label></div>
        </fieldset>
        <div className="zm-actions"><button type="submit" className="zm-btn primary brand" disabled={busy} aria-busy={busy}>{t("ob.auth.sendCode")}</button></div>
        <p className="zm-hint">{t("ob.auth.consent")}</p>
      </form>
    );
  }

  if (stage.kind === "otp") {
    const masked = normalizePhone(phone) ?? phone;
    return (
      <form className="zm-form" noValidate onSubmit={(e) => { e.preventDefault(); void verify(); }}>
        {errorBlock}
        <p>{t("ob.auth.codeSent", { phone: masked.length > 4 ? `••••${masked.slice(-3)}` : masked })}</p>
        <div className="zm-field">
          <label htmlFor="sa-code">{t("ob.auth.code")}</label>
          <input id="sa-code" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={12} value={code} onChange={(e) => setCode(e.target.value)} aria-invalid={fieldErr.code !== undefined} aria-describedby={fieldErr.code === undefined ? undefined : "sa-code-e"} required />
          {fieldErr.code === undefined ? null : <p id="sa-code-e" className="zm-err">{t(fieldErr.code)}</p>}
        </div>
        <div className="zm-actions">
          <button type="submit" className="zm-btn primary brand" disabled={busy} aria-busy={busy}>{t("ob.auth.verify")}</button>
          <button type="button" className="zm-btn quiet" disabled={busy || left > 0} onClick={() => void sendCode()}>
            {left > 0 ? t("ob.auth.resendIn", { s: left }) : t("ob.auth.resend")}
          </button>
          <button type="button" className="zm-btn quiet" onClick={() => setStage({ kind: "phone" })}>{t("ob.auth.changePhone")}</button>
        </div>
      </form>
    );
  }

  const enrol = stage.step === "enrol_passkey" || stage.step === "enrol_totp";
  const isPasskey = stage.step === "enrol_passkey" || stage.step === "assert_passkey";
  const parsed = totpSetup === null ? null : parseOtpauth(totpSetup.uri);
  return (
    <div className="zm-form">
      {errorBlock}
      <h3 className="zm-h3">{enrol ? t("ob.strong.enrolTitle") : t("ob.strong.assertTitle")}</h3>
      {stage.unsupported ? <p role="status" className="zm-hint">{t("ob.strong.unsupported")}</p> : null}
      {isPasskey ? (
        <div>
          <p>{enrol ? t("ob.strong.passkeyEnrolBody") : t("ob.strong.passkeyAssertBody")}</p>
          <div className="zm-actions">
            <button type="button" className="zm-btn primary brand" disabled={busy} aria-busy={busy} onClick={() => void passkey(enrol ? "register" : "assert")}>
              {enrol ? t("ob.strong.createPasskey") : t("ob.strong.usePasskey")}
            </button>
          </div>
        </div>
      ) : enrol && totpSetup === null ? (
        <div>
          <p>{t("ob.strong.totpIntro")}</p>
          <div className="zm-actions"><button type="button" className="zm-btn primary brand" disabled={busy} aria-busy={busy} onClick={() => void startTotpEnrol()}>{t("ob.strong.startTotp")}</button></div>
        </div>
      ) : enrol && totpSetup !== null ? (
        <div>
          <ol className="zm-steps">
            <li>
              <p>{t("ob.totp.scan")}</p>
              <QrCode text={totpSetup.uri} label={t("ob.totp.qrLabel")} />
              {parsed === null ? null : (
                <p className="zm-hint">{t("ob.totp.manual")} <code dir="ltr" className="zm-code">{groupSecret(parsed.secret)}</code></p>
              )}
            </li>
            <li>
              <p><strong>{t("ob.totp.recoveryTitle")}</strong></p>
              <p className="zm-hint">{t("ob.totp.recoveryBody")}</p>
              <ul className="zm-codes" dir="ltr">{totpSetup.codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
              <div className="zm-actions"><button type="button" className="zm-btn quiet" onClick={() => void copyCodes()}>{copied ? t("ob.totp.copied") : t("ob.totp.copy")}</button></div>
              <div className="zm-check">
                <input id="sa-ack" type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />
                <label htmlFor="sa-ack">{t("ob.totp.ack")}</label>
              </div>
            </li>
            <li>
              <div className="zm-field">
                <label htmlFor="sa-totp">{t("ob.totp.enterCode")}</label>
                <input id="sa-totp" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={12} value={totpCode} disabled={!canLeaveRecoveryCodes(acknowledged, true)} onChange={(e) => setTotpCode(e.target.value)} aria-invalid={fieldErr.totp !== undefined} aria-describedby={fieldErr.totp === undefined ? "sa-totp-h" : "sa-totp-h sa-totp-e"} />
                <p id="sa-totp-h" className="zm-hint">{canLeaveRecoveryCodes(acknowledged, true) ? t("ob.totp.enterHint") : t("ob.totp.ackFirst")}</p>
                {fieldErr.totp === undefined ? null : <p id="sa-totp-e" className="zm-err">{t(fieldErr.totp)}</p>}
              </div>
              <div className="zm-actions"><button type="button" className="zm-btn primary brand" disabled={busy || !canLeaveRecoveryCodes(acknowledged, true)} aria-busy={busy} onClick={() => void finishTotp("confirm")}>{t("ob.totp.confirm")}</button></div>
            </li>
          </ol>
        </div>
      ) : (
        <form noValidate onSubmit={(e) => { e.preventDefault(); void finishTotp("assert"); }}>
          <div className="zm-field">
            <label htmlFor="sa-totp-a">{t("ob.totp.enterCode")}</label>
            <input id="sa-totp-a" inputMode="numeric" autoComplete="one-time-code" dir="ltr" maxLength={12} value={totpCode} onChange={(e) => setTotpCode(e.target.value)} aria-invalid={fieldErr.totp !== undefined} aria-describedby={fieldErr.totp === undefined ? undefined : "sa-totp-ae"} />
            {fieldErr.totp === undefined ? null : <p id="sa-totp-ae" className="zm-err">{t(fieldErr.totp)}</p>}
          </div>
          <div className="zm-actions"><button type="submit" className="zm-btn primary brand" disabled={busy} aria-busy={busy}>{t("ob.auth.verify")}</button></div>
        </form>
      )}
      {stage.canSwitch && totpSetup === null && (passkeySupported || !isPasskey) ? (
        <div className="zm-actions">
          <button type="button" className="zm-btn quiet" onClick={() => { setError(null); setFieldErr({}); setStage({ ...stage, step: switchMethod(stage.step) }); }}>
            {isPasskey ? t("ob.strong.useTotpInstead") : t("ob.strong.usePasskeyInstead")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
