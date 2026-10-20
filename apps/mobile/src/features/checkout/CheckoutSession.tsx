import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { formatMoney, localizeDigits, type DisplayLocale } from "../money-display";
import { takeAdmission } from "../drops/admissionStore";
import type { AdmissionToken } from "../drops/model";
import { getFeaturePorts } from "../../state/ports";
import { useOptionalServices } from "../../state/services";
import {
  EMPTY_ADDRESS, PortError, applyOrderStatus, applyPlaceFailure, applyPlaceResult, bagFingerprint, beginSubmit, buildPlaceRequest, checkoutFailureState,
  computeTotals, initialSelection, placeBlockers, requestFingerprint, restoreSession, sessionSnapshot, sessionSnapshotKey, uuidv7,
  type AddressesPort, type CheckoutPort, type CheckoutQuote, type CheckoutScreenState, type CheckoutSelection, type CheckoutStep, type ClientAction,
  type MapPinPort, type PaymentLauncherPort, type SavedAddress, type SessionSnapshot, type Submission, type Totals,
} from "./model";

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues === undefined) throw new Error("no CSPRNG available");
  return uuidv7(Date.now(), c.getRandomValues(new Uint8Array(10)));
}

/** Where the resumable snapshot lives. Only non-personal choices are ever written (see `sessionSnapshot`). */
export interface SnapshotStore {
  read(key: string): Promise<unknown>;
  write(key: string, value: SessionSnapshot): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Analytics seam (consent gating lives inside ClientAnalytics.track). Fire and forget. */
export interface CheckoutTelemetry {
  stepViewed(step: CheckoutStep, storeCount: number): void;
  stepCompleted(step: CheckoutStep, msOnStep: number): void;
}

export interface CheckoutSessionProps {
  readonly children: ReactNode;
  readonly port?: CheckoutPort;
  readonly launcher?: PaymentLauncherPort;
  readonly mapPin?: MapPinPort;
  readonly addresses?: AddressesPort;
  readonly snapshots?: SnapshotStore;
  readonly telemetry?: CheckoutTelemetry;
  readonly resumeOrderGroupId?: string;
  readonly dropId?: string;
  readonly now?: () => number;
}

export interface CheckoutSessionValue {
  readonly lang: "ar" | "en";
  readonly state: CheckoutScreenState;
  readonly quote: CheckoutQuote | null;
  readonly sel: CheckoutSelection | null;
  readonly totals: Totals | null;
  readonly empty: boolean;
  readonly reconfirmed: bigint | null;
  readonly acceptDelta: (d: bigint) => void;
  readonly submission: Submission;
  readonly action: ClientAction | null;
  readonly notice: string | null;
  readonly setNotice: (n: string | null) => void;
  readonly saved: readonly SavedAddress[];
  readonly savedId: string | null;
  readonly selectSaved: (a: SavedAddress | null) => void;
  readonly update: (patch: Partial<CheckoutSelection>) => void;
  readonly mapPin: MapPinPort;
  readonly admissionMissing: boolean;
  /** Step the shopper last left off at (restored snapshot); null on a fresh session. Read once by the first step. */
  readonly restoredStep: CheckoutStep | null;
  readonly reload: () => void;
  readonly place: () => Promise<boolean>;
  readonly checkStatus: () => Promise<void>;
  readonly noteStep: (step: CheckoutStep) => void;
  readonly telemetry: CheckoutTelemetry;
  readonly money: (m: bigint) => string;
  readonly num: (n: number) => string;
  /** Back is blocked while the order is being placed or its payment is pending. */
  readonly locked: boolean;
}

const Ctx = createContext<CheckoutSessionValue | null>(null);

export function useCheckoutSession(): CheckoutSessionValue {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useCheckoutSession must be used inside CheckoutSessionProvider");
  return v;
}

const NOOP_TELEMETRY: CheckoutTelemetry = { stepViewed: () => undefined, stepCompleted: () => undefined };

/**
 * Owns the quote, selection, submission, idempotency key and admission token for as long as the checkout layout is mounted
 * (ADR-0053). The key is created only inside `place()`, exactly as the one-page screen did.
 */
export function CheckoutSessionProvider(props: CheckoutSessionProps) {
  const { t, i18n } = useTranslation();
  const lang: "ar" | "en" = i18n.language === "en" ? "en" : "ar";
  const locale: DisplayLocale = lang;
  const services = useOptionalServices();
  const port = useMemo<CheckoutPort>(() => props.port ?? getFeaturePorts().checkout, [props.port]);
  const launcher = useMemo<PaymentLauncherPort>(() => props.launcher ?? getFeaturePorts().paymentLauncher, [props.launcher]);
  const mapPin = useMemo<MapPinPort>(() => props.mapPin ?? getFeaturePorts().mapPin, [props.mapPin]);
  const addressesPort = useMemo<AddressesPort>(() => props.addresses ?? getFeaturePorts().addresses, [props.addresses]);
  const now = props.now ?? Date.now;
  const currency = t("common.currency");
  const money = useCallback((m: bigint) => formatMoney(m, locale, currency), [locale, currency]);
  const num = useCallback((n: number) => localizeDigits(String(n), locale), [locale]);

  const snapshots = useMemo<SnapshotStore | null>(() => {
    if (props.snapshots !== undefined) return props.snapshots;
    const storage = services?.storage;
    if (storage === undefined) return null;
    return {
      read: async (key) => {
        const raw = await storage.getString(key);
        return raw === null ? null : (JSON.parse(raw) as unknown);
      },
      write: (key, value) => storage.setString(key, JSON.stringify(value)),
      remove: (key) => storage.remove(key),
    };
  }, [props.snapshots, services]);

  const telemetry = useMemo<CheckoutTelemetry>(() => {
    if (props.telemetry !== undefined) return props.telemetry;
    const analytics = services?.analytics;
    if (analytics === undefined) return NOOP_TELEMETRY;
    return {
      stepViewed: (step, storeCount) => { void analytics.track("checkout_step_viewed", { step, store_count: Math.min(storeCount, 99) }).catch(() => false); },
      stepCompleted: (step, ms) => { void analytics.track("checkout_step_completed", { step, ms_on_step: Math.max(0, Math.round(ms)) }).catch(() => false); },
    };
  }, [props.telemetry, services]);

  const dropId = props.dropId;
  const [admission] = useState<AdmissionToken | null>(() => (dropId !== undefined && dropId !== "" ? takeAdmission(dropId) : null));
  const admissionMissing = dropId !== undefined && dropId !== "" && admission === null;
  const [state, setState] = useState<CheckoutScreenState>({ status: "loading" });
  const [sel, setSel] = useState<CheckoutSelection | null>(null);
  const [reconfirmed, setReconfirmed] = useState<bigint | null>(null);
  const [submission, setSubmission] = useState<Submission>(
    props.resumeOrderGroupId !== undefined ? { status: "awaitingPayment", key: "", fingerprint: "", orderGroupId: props.resumeOrderGroupId } : { status: "idle" },
  );
  const [action, setAction] = useState<ClientAction | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<readonly SavedAddress[] | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [restoredStep, setRestoredStep] = useState<CheckoutStep | null>(null);
  const inFlight = useRef(false);
  const restoreTried = useRef(false);
  const currentStep = useRef<CheckoutStep>("delivery");

  const reload = useCallback(() => {
    setState({ status: "loading" });
    port.quote({ address: EMPTY_ADDRESS }).then(
      (q) => { setState({ status: "ready", quote: q }); setSel((prev) => prev ?? initialSelection(q)); },
      (e: unknown) => setState(checkoutFailureState(e)),
    );
  }, [port]);
  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    let alive = true;
    addressesPort.list().then(
      (list) => { if (alive) setSaved(list); },
      () => { if (alive) setSaved([]); },
    );
    return () => { alive = false; };
  }, [addressesPort]);

  const quote = state.status === "ready" ? state.quote : null;
  const fingerprint = quote !== null ? bagFingerprint(quote) : null;

  // Once the quote and saved addresses are both known: restore a fresh snapshot, otherwise preselect the default address.
  useEffect(() => {
    if (restoreTried.current || quote === null || sel === null || saved === null || fingerprint === null) return;
    restoreTried.current = true;
    const finish = (snap: SessionSnapshot | null): void => {
      const chosen = snap?.savedAddressId !== null && snap !== null ? saved.find((a) => a.id === snap.savedAddressId) : undefined;
      const def = chosen ?? (snap === null ? (saved.find((a) => a.isDefault) ?? saved[0]) : undefined);
      setSavedId(def?.id ?? null);
      setSel((s) => {
        if (s === null) return s;
        const base = def !== undefined ? { ...s, address: def.draft } : s;
        return snap === null ? base : { ...base, delivery: { ...s.delivery, ...snap.delivery }, paymentMethodId: snap.paymentMethodId, voucherCodes: snap.voucherCodes, useStoreCredit: snap.useStoreCredit };
      });
      if (snap !== null) setRestoredStep(snap.step);
    };
    if (snapshots === null || props.resumeOrderGroupId !== undefined) { finish(null); return; }
    const key = sessionSnapshotKey(fingerprint);
    snapshots.read(key).then(
      (raw) => {
        const snap = raw === null ? null : restoreSession(raw, quote, now());
        if (raw !== null && snap === null) void snapshots.remove(key).catch(() => undefined);
        finish(snap);
      },
      () => finish(null),
    );
  }, [quote, sel, saved, fingerprint, snapshots, now, props.resumeOrderGroupId]);

  const persist = useCallback((s: CheckoutSelection, sid: string | null) => {
    if (snapshots === null || fingerprint === null || !restoreTried.current) return;
    void snapshots.write(sessionSnapshotKey(fingerprint), sessionSnapshot(currentStep.current, s, sid, now())).catch(() => undefined);
  }, [snapshots, fingerprint, now]);
  useEffect(() => { if (sel !== null && submission.status !== "done") persist(sel, savedId); }, [sel, savedId, submission.status, persist]);

  const noteStep = useCallback((step: CheckoutStep) => {
    currentStep.current = step;
    if (sel !== null) persist(sel, savedId);
  }, [sel, savedId, persist]);

  const checkStatusFor = useCallback(async (s: Extract<Submission, { status: "awaitingPayment" }>) => {
    try {
      setSubmission(applyOrderStatus(s, await port.orderGroupStatus(s.orderGroupId)));
    } catch {
      setNotice(t("checkout.networkRetry"));
    }
  }, [port, t]);

  useEffect(() => {
    if (props.resumeOrderGroupId !== undefined) {
      void checkStatusFor({ status: "awaitingPayment", key: "", fingerprint: "", orderGroupId: props.resumeOrderGroupId });
    }
  }, [props.resumeOrderGroupId, checkStatusFor]);

  const update = useCallback((patch: Partial<CheckoutSelection>) => {
    setSel((s) => (s === null ? s : { ...s, ...patch }));
    setSubmission((s) => (s.status === "failed" ? { status: "idle" } : s));
  }, []);
  const selectSaved = useCallback((a: SavedAddress | null) => {
    setSavedId(a?.id ?? null);
    update({ address: a?.draft ?? EMPTY_ADDRESS });
  }, [update]);

  const totals = quote !== null && sel !== null ? computeTotals(quote, sel) : null;
  const empty = quote !== null && quote.shipments.every((s) => s.lines.length === 0);

  const place = async (): Promise<boolean> => {
    if (quote === null || sel === null || totals === null || inFlight.current || admissionMissing) return false;
    if (placeBlockers(quote, sel, reconfirmed).length > 0) return false;
    const method = quote.paymentMethods.find((m) => m.id === sel.paymentMethodId);
    const codSelected = method?.kind === "cod";
    const request = buildPlaceRequest(quote, sel, totals);
    let step;
    try {
      step = beginSubmit(submission, requestFingerprint(request), newIdempotencyKey);
    } catch {
      setNotice(t("checkout.failedGeneric"));
      return false;
    }
    if (!step.start) return false;
    inFlight.current = true;
    setNotice(null);
    setSubmission(step.submission);
    const submitting = step.submission as Extract<Submission, { status: "submitting" }>;
    try {
      const result = await port.place(request, step.key, admission?.value ?? null);
      const out = applyPlaceResult(submitting, result, codSelected);
      if (out.quote !== null) { setState({ status: "ready", quote: out.quote }); setReconfirmed(null); }
      setSubmission(out.submission);
      if (result.kind === "requires_action") {
        setAction(result.action);
        if (result.action.type !== "none" && result.action.type !== "reference_code") {
          const outcome = await launcher.launch(result.action);
          if (outcome === "cancelled") setNotice(t("checkout.paymentCancelled"));
        }
        if (out.submission.status === "awaitingPayment") await checkStatusFor(out.submission);
      }
      if (out.submission.status === "done" && snapshots !== null && fingerprint !== null) void snapshots.remove(sessionSnapshotKey(fingerprint)).catch(() => undefined);
    } catch (e) {
      setSubmission(applyPlaceFailure(submitting));
      setNotice(t(e instanceof PortError && e.kind === "offline" ? "checkoutSteps.placeOffline" : "checkout.networkRetry"));
    } finally {
      inFlight.current = false;
    }
    return true;
  };

  const value: CheckoutSessionValue = {
    lang, state, quote, sel, totals, empty, reconfirmed, acceptDelta: setReconfirmed, submission, action, notice, setNotice,
    saved: saved ?? [], savedId, selectSaved, update, mapPin, admissionMissing, restoredStep, reload, place,
    checkStatus: async () => { if (submission.status === "awaitingPayment") await checkStatusFor(submission); },
    noteStep, telemetry, money, num,
    locked: submission.status === "submitting" || submission.status === "awaitingPayment",
  };
  return <Ctx.Provider value={value}>{props.children}</Ctx.Provider>;
}
