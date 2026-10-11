import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createAgeGate, createApi, type OutletApi } from "../api";
import type { AgeGatePort } from "../api/age-gate";
import { ClientAnalytics } from "../features/analytics";
import { CONSENT_VERSIONS, ConsentController, PersistedConsentSchema } from "../features/consent";
import { expoSecureStoreBackend } from "../platform/expo-secure-store-backend";
import { randomUrlSafeId } from "../platform/random";
import { SecureStorage, STORAGE_KEYS, TokenStorage } from "../platform/secure-storage";
import {
  SoftBlockSchema,
  createRecordingTransport,
  isDeviceBlocked,
  sha256Hex,
  type CivilDate,
  type DeviceSoftBlock,
  type Transport,
} from "../workspace";

/** In-flight onboarding values. Memory only: never persisted, never logged. */
export interface OnboardingSession {
  phoneE164: string | null;
  sendsSoFar: number;
  lastSentAtMs: number;
  /** Date of birth accepted by the age gate, held in memory only until it is submitted after OTP. */
  pendingDob: CivilDate | null;
}

export interface AppServices {
  readonly api: OutletApi;
  readonly ageGate: AgeGatePort;
  readonly storage: SecureStorage;
  readonly tokens: TokenStorage;
  readonly consent: ConsentController;
  readonly analytics: ClientAnalytics;
  readonly session: OnboardingSession;
  readonly clock: { now(): Date };
  installId(): Promise<string>;
  loadSoftBlock(): Promise<DeviceSoftBlock | null>;
  saveSoftBlock(block: DeviceSoftBlock): Promise<void>;
  isThisDeviceBlocked(): Promise<boolean>;
  isOnboardingDone(): Promise<boolean>;
  markOnboardingDone(): Promise<void>;
  /** Where to continue after an app restart mid-onboarding (only steps after the age gate are ever stored). */
  setResume(step: ResumableStep): Promise<void>;
  getResume(): Promise<ResumableStep | null>;
}

export type ResumableStep = "phone" | "language" | "consents";

const systemClock = { now: () => new Date() };

/** Dev-only sink: records in memory, sends nothing. Release builds get a transport that discards. */
function makeTransport(): Transport {
  return typeof __DEV__ !== "undefined" && __DEV__
    ? createRecordingTransport()
    : { send: () => undefined };
}

export function createServices(): AppServices {
  const clock = systemClock;
  const storage = new SecureStorage(expoSecureStoreBackend);
  const isDev = typeof __DEV__ !== "undefined" && __DEV__;
  const api = createApi(clock, isDev);
  const ageGate = createAgeGate(clock, isDev);
  const consent = new ConsentController({
    clock,
    api,
    persistence: {
      read: () => storage.getJson(STORAGE_KEYS.consent, PersistedConsentSchema),
      write: (d) => storage.setJson(STORAGE_KEYS.consent, d),
    },
  });
  const analytics = new ClientAnalytics({
    consent,
    versions: CONSENT_VERSIONS,
    clock,
    ids: { next: () => randomUrlSafeId(24) },
    start: () => ({ transport: makeTransport(), stop: () => undefined }),
  });
  let cachedInstallId: string | null = null;
  const installId = async (): Promise<string> => {
    if (cachedInstallId !== null) return cachedInstallId;
    const existing = await storage.getString(STORAGE_KEYS.installId);
    if (existing !== null) return (cachedInstallId = existing);
    const fresh = randomUrlSafeId(32);
    await storage.setString(STORAGE_KEYS.installId, fresh);
    return (cachedInstallId = fresh);
  };
  const loadSoftBlock = () => storage.getJson(STORAGE_KEYS.deviceSoftBlock, SoftBlockSchema);
  return {
    api,
    ageGate,
    storage,
    tokens: new TokenStorage(storage),
    consent,
    analytics,
    session: { phoneE164: null, sendsSoFar: 0, lastSentAtMs: 0, pendingDob: null },
    clock,
    installId,
    loadSoftBlock,
    saveSoftBlock: (b) => storage.setJson(STORAGE_KEYS.deviceSoftBlock, SoftBlockSchema.parse(b)),
    isThisDeviceBlocked: async () => {
      const block = await loadSoftBlock();
      if (block === null) return false;
      return isDeviceBlocked(block, await installId(), sha256Hex, clock);
    },
    isOnboardingDone: async () => (await storage.getString(STORAGE_KEYS.onboardingDone)) === "1",
    markOnboardingDone: () => storage.setString(STORAGE_KEYS.onboardingDone, "1"),
    setResume: (step) => storage.setString(STORAGE_KEYS.onboardingResume, step),
    getResume: async () => {
      const v = await storage.getString(STORAGE_KEYS.onboardingResume);
      return v === "phone" || v === "language" || v === "consents" ? v : null;
    },
  };
}

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider(props: { children: ReactNode }) {
  const services = useMemo(() => createServices(), []);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const unsubscribe = services.consent.subscribe(() => {
      services.analytics.sync();
    });
    void (async () => {
      try {
        await services.consent.load();
        services.analytics.sync();
        await services.consent.flushPending();
      } catch {
        // Storage unavailable: continue with nothing granted (fail closed).
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [services]);

  if (!ready) return null;
  return <ServicesContext.Provider value={services}>{props.children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (s === null) throw new Error("useServices must be used inside ServicesProvider");
  return s;
}
