"use client";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import type { Locale } from "@outlet/i18n";
import { Button, Field } from "@outlet/ui-web";
import { browserApi, type ShopperApi } from "../../lib/client-api";
import { maskPhone, normalizeCode, normalizeEgPhone } from "../../lib/phone";
import type { ConsentState } from "../../lib/wire";
import { Alert, isProblem, safeNext, useShared } from "./shared";

export interface WebAuthnPort {
  supported: () => boolean;
  authenticate: (publicKey: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
const browserWebAuthn: WebAuthnPort = {
  supported: () => typeof window !== "undefined" && typeof window.PublicKeyCredential === "function",
  async authenticate(publicKey) {
    const { startAuthentication } = await import("@simplewebauthn/browser");
    const response = await startAuthentication({ optionsJSON: publicKey as unknown as Parameters<typeof startAuthentication>[0]["optionsJSON"] });
    return { ...response };
  },
};

const MIN_AGE = 18;
/** Whole years between a YYYY-MM-DD date of birth and today (UTC date parts; the server re-checks). */
export function ageOn(dob: string, today: Date): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < mo || (today.getUTCMonth() + 1 === mo && today.getUTCDate() < d)) age -= 1;
  return age >= 0 ? age : null;
}

type Step = "phone" | "code" | "consents";
type Mode = "sign_in" | "register";

export interface LoginFormProps {
  readonly locale: Locale;
  readonly next?: string | null;
  readonly api?: ShopperApi;
  readonly webauthn?: WebAuthnPort;
  readonly navigate?: (href: string) => void;
  readonly now?: () => Date;
}

export function LoginForm({ locale, next, api = browserApi(), webauthn = browserWebAuthn, navigate = (h) => { window.location.assign(h); }, now = () => new Date() }: LoginFormProps) {
  const { t, base } = useShared(locale);
  const [step, setStep] = useState<Step>("phone");
  const [mode, setMode] = useState<Mode>("sign_in");
  const [phone, setPhone] = useState("");
  const [e164, setE164] = useState("");
  const [dob, setDob] = useState("");
  const [attest, setAttest] = useState(false);
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [consents, setConsents] = useState<readonly ConsentState[]>([]);
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const [passkeyOk, setPasskeyOk] = useState(false);
  const codeRef = useRef<HTMLDivElement>(null);
  const target = safeNext(next, base);

  useEffect(() => { setPasskeyOk(webauthn.supported()); }, [webauthn]);
  useEffect(() => {
    if (secondsLeft <= 0) return undefined;
    const id = setTimeout(() => { setSecondsLeft((s) => s - 1); }, 1000);
    return () => { clearTimeout(id); };
  }, [secondsLeft]);

  const fail = (e: unknown, fallback: string): void => {
    // Decided by the problem `type` (urn:outlex:problem:<code>), not the HTTP status.
    const problem = isProblem(e) ? e : null;
    const type = problem?.type ?? "";
    if (type === "rate-limited" || type === "otp-locked") {
      const s = problem?.retryAfterS ?? 60;
      setSecondsLeft(s);
      setError(t("auth.rateLimited", { seconds: s }));
    } else if (type === "under-age" || type === "age-blocked") setError(t("auth.underage", { age: MIN_AGE }));
    else setError(fallback);
  };

  async function requestCode(): Promise<void> {
    const p = normalizeEgPhone(phone);
    if (p === null) { setError(t("auth.phone.invalid")); return; }
    if (mode === "register") {
      const age = ageOn(dob, now());
      if (age === null) { setError(t("auth.dob.invalid")); return; }
      if (!attest) { setError(t("auth.attest18.required", { age: MIN_AGE })); return; }
      if (age < MIN_AGE) { setError(t("auth.underage", { age: MIN_AGE })); return; }
    }
    setBusy(true);
    setError(null);
    try {
      const c = await api.requestOtp(p, mode);
      setE164(p);
      setChallenge(c.challengeId);
      setSecondsLeft(c.resendAfterS);
      setStep("code");
      setCode("");
    } catch (e) {
      fail(e, t("error.generic"));
    } finally { setBusy(false); }
  }

  async function finish(isNew: boolean): Promise<void> {
    if (!isNew) { navigate(target); return; }
    try {
      const list = await api.listConsents();
      if (list.length === 0) { navigate(target); return; }
      setConsents(list);
      setTicked(new Set());
      setStep("consents");
    } catch { navigate(target); }
  }

  async function verify(): Promise<void> {
    const c = normalizeCode(code);
    if (c === null) { setError(t("auth.code.invalid", { digits: 6 })); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api.verifyOtp({ challengeId: challenge, phoneE164: e164, code: c, ...(mode === "register" ? { dob } : {}) });
      await finish(r.isNewUser);
    } catch (e) {
      if (isProblem(e) && e.type === "dob-required") { setMode("register"); setStep("phone"); setError(t("auth.ageGateRequired")); }
      else fail(e, t("auth.code.wrong"));
    } finally { setBusy(false); }
  }

  async function passkey(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const o = await api.passkeyOptions();
      const credential = await webauthn.authenticate(o.publicKey);
      const r = await api.passkeyVerify(o.challengeId, credential);
      await finish(r.isNewUser);
    } catch (e) { fail(e, t("auth.passkey.failed")); } finally { setBusy(false); }
  }

  async function saveConsents(): Promise<void> {
    setBusy(true);
    try {
      const changes = consents.filter((c) => ticked.has(c.purpose_code)).map((c) => ({ code: c.purpose_code, version: c.purpose_version, granted: true }));
      if (changes.length > 0) await api.patchConsents(changes);
      navigate(target);
    } catch { setError(t("error.generic")); setBusy(false); }
  }

  const submit = (fn: () => Promise<void>) => (e: SyntheticEvent) => { e.preventDefault(); void fn(); };

  if (step === "consents") {
    return (
      <form onSubmit={submit(saveConsents)} className="shopForm" aria-labelledby="consent-title">
        <h2 id="consent-title">{t("auth.consents.title")}</h2>
        <p className="hint">{t("auth.consents.hint")}</p>
        {consents.map((c) => (
          <label key={c.purpose_code} className="shopCheck">
            <input type="checkbox" checked={ticked.has(c.purpose_code)} onChange={(e) => { setTicked((prev) => { const n = new Set(prev); if (e.target.checked) n.add(c.purpose_code); else n.delete(c.purpose_code); return n; }); }} />
            <span>{locale === "en-EG" && c.text_en !== null ? c.text_en : c.text_ar}</span>
          </label>
        ))}
        {error === null ? null : <Alert>{error}</Alert>}
        <div className="shopRow">
          <Button type="submit" loading={busy}>{t("auth.consents.save")}</Button>
          <Button variant="ghost" onClick={() => { navigate(target); }}>{t("auth.consents.skip")}</Button>
        </div>
      </form>
    );
  }

  if (step === "code") {
    return (
      <form noValidate onSubmit={submit(verify)} className="shopForm" aria-labelledby="login-title">
        <p className="hint" dir="ltr">{t("auth.codeSentTo", { phone: maskPhone(e164) })}</p>
        <div ref={codeRef}>
          <Field label={t("auth.code.label", { digits: 6 })} value={code} onChange={(e) => { setCode(e.target.value); }} inputMode="numeric" autoComplete="one-time-code" maxLength={12} required dir="ltr" />
        </div>
        {error === null ? null : <Alert>{error}</Alert>}
        <div className="shopRow">
          <Button type="submit" loading={busy}>{t("auth.verify")}</Button>
          <Button variant="secondary" disabled={secondsLeft > 0 || busy} onClick={() => { void requestCode(); }}>
            {secondsLeft > 0 ? t("auth.resendIn", { seconds: secondsLeft }) : t("auth.resend")}
          </Button>
          <Button variant="ghost" onClick={() => { setStep("phone"); setError(null); }}>{t("auth.changePhone")}</Button>
        </div>
      </form>
    );
  }

  return (
    <form noValidate onSubmit={submit(requestCode)} className="shopForm" aria-labelledby="login-title">
      <Field label={t("auth.phone.label")} hint={t("auth.phone.hint", { example: "01012345678" })} value={phone} onChange={(e) => { setPhone(e.target.value); }} type="tel" inputMode="tel" autoComplete="tel" required dir="ltr" />
      {mode === "register" ? (
        <>
          <Field label={t("auth.dob.label")} type="date" value={dob} onChange={(e) => { setDob(e.target.value); }} autoComplete="bday" required />
          <label className="shopCheck">
            <input type="checkbox" checked={attest} onChange={(e) => { setAttest(e.target.checked); }} />
            <span>{t("auth.attest18", { age: MIN_AGE })}</span>
          </label>
        </>
      ) : null}
      {error === null ? null : <Alert>{error}</Alert>}
      <Button type="submit" loading={busy}>{t("auth.sendCode")}</Button>
      <Button variant="ghost" onClick={() => { setMode(mode === "sign_in" ? "register" : "sign_in"); setError(null); }}>
        {mode === "sign_in" ? t("auth.newHere") : t("auth.haveAccount")}
      </Button>
      {passkeyOk ? (
        <>
          <p className="hint">{t("auth.or")}</p>
          <Button variant="secondary" loading={busy} onClick={() => { void passkey(); }}>{t("auth.passkey.use")}</Button>
        </>
      ) : null}
    </form>
  );
}
