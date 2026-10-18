import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useServices } from "../../state/services";
import {
  DRAFT_STORAGE_KEY, EMPTY_DRAFT, parseDraft, errorCodeOf,
  type ApplicationView, type ErrorCode, type Lang, type PersistedDraft, type Requirements, type Step,
} from "./model";
import { getBrandApply, type BrandApplyKit } from "./registry";

export interface AccountForm { brandName: string; phone: string; email: string }

export interface BrandApplyState {
  readonly kit: BrandApplyKit;
  readonly lang: Lang;
  readonly ready: boolean;
  readonly draft: PersistedDraft;
  /** True once the seller identity has a verified OTP in this app run (a restart signs the brand back in). */
  readonly otpVerified: boolean;
  readonly strongFactor: boolean;
  /** The identity already has a strong factor on the server but this app run has not signed in with it yet. */
  readonly needsAssert: boolean;
  readonly account: AccountForm;
  readonly app: ApplicationView | null;
  readonly requirements: Requirements | null;
  patchDraft(p: Partial<PersistedDraft>): void;
  setAccount(p: Partial<AccountForm>): void;
  setSession(p: { otpVerified?: boolean; strongFactor?: boolean; needsAssert?: boolean }): void;
  setApp(a: ApplicationView | null): void;
  setRequirements(r: Requirements | null): void;
  /** Saves the step the user is on so closing the app resumes there. */
  rememberStep(step: Step): void;
  clearDraft(): void;
}

const Ctx = createContext<BrandApplyState | null>(null);

export function useBrandApply(): BrandApplyState {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useBrandApply must be used inside BrandApplyProvider");
  return v;
}

export function BrandApplyProvider(props: { children: ReactNode; kit?: BrandApplyKit }) {
  const { i18n } = useTranslation();
  const { storage } = useServices();
  const kit = useMemo(() => props.kit ?? getBrandApply(), [props.kit]);
  const lang: Lang = i18n.language === "en" ? "en" : "ar";
  const [ready, setReady] = useState(false);
  const [draft, setDraft] = useState<PersistedDraft>(EMPTY_DRAFT);
  const [otpVerified, setOtp] = useState(false);
  const [strongFactor, setStrong] = useState(false);
  const [needsAssert, setNeedsAssert] = useState(false);
  const [account, setAcc] = useState<AccountForm>({ brandName: "", phone: "", email: "" });
  const [app, setApp] = useState<ApplicationView | null>(null);
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  useEffect(() => {
    let alive = true;
    void (async () => {
      const raw = await storage.getString(DRAFT_STORAGE_KEY).catch(() => null);
      if (!alive) return;
      const d = parseDraft(raw);
      setDraft(d);
      setAcc((a) => ({ ...a, brandName: d.brandName ?? "" }));
      setReady(true);
    })();
    return () => { alive = false; };
  }, [storage]);

  const persist = useCallback((d: PersistedDraft) => { storage.setString(DRAFT_STORAGE_KEY, JSON.stringify(d)).catch(() => undefined); }, [storage]);
  const patchDraft = useCallback((p: Partial<PersistedDraft>) => {
    const next = { ...draftRef.current, ...p };
    draftRef.current = next;
    setDraft(next);
    persist(next);
  }, [persist]);
  const rememberStep = useCallback((step: Step) => { if (draftRef.current.step !== step) patchDraft({ step }); }, [patchDraft]);
  const clearDraft = useCallback(() => {
    draftRef.current = EMPTY_DRAFT;
    setDraft(EMPTY_DRAFT);
    setApp(null);
    setRequirements(null);
    storage.remove(DRAFT_STORAGE_KEY).catch(() => undefined);
  }, [storage]);

  const value = useMemo<BrandApplyState>(() => ({
    kit, lang, ready, draft, otpVerified, strongFactor, needsAssert, account, app, requirements,
    patchDraft, rememberStep, clearDraft, setApp, setRequirements,
    setAccount: (p) => setAcc((a) => ({ ...a, ...p })),
    setSession: (p) => { if (p.otpVerified !== undefined) setOtp(p.otpVerified); if (p.strongFactor !== undefined) setStrong(p.strongFactor); if (p.needsAssert !== undefined) setNeedsAssert(p.needsAssert); },
  }), [kit, lang, ready, draft, otpVerified, strongFactor, needsAssert, account, app, requirements, patchDraft, rememberStep, clearDraft]);
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}

/** Runs an async action; failures become a stable error code for the screen to show (never the raw error). */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorCode | null>(null);
  const inFlight = useRef(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    if (inFlight.current) return undefined;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try { return await fn(); } catch (e) { setError(errorCodeOf(e)); return undefined; } finally { inFlight.current = false; setBusy(false); }
  }, []);
  return { busy, error, run, clear: useCallback(() => setError(null), []) };
}
