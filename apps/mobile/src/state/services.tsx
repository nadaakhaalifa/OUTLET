import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform } from "react-native";
import i18next from "i18next";
import { createAgeGate, createApi, type OutletApi } from "../api";
import type { AgeGatePort } from "../api/age-gate";
import { ClientAnalytics } from "../features/analytics";
import { BLOCKED_GATE, FetchIngestTransport, configureIngest, getIngestEmitter } from "../features/analytics-ingest";
import { CONSENT_VERSIONS, ConsentController, PersistedConsentSchema } from "../features/consent";
import { expoSecureStoreBackend } from "../platform/expo-secure-store-backend";
import { randomUrlSafeId } from "../platform/random";
import { SecureStorage, STORAGE_KEYS, TokenStorage } from "../platform/secure-storage";
import { apiBaseUrlFromEnv, configureApiRuntime, getSharedClient, type ApiRuntime } from "../services/runtime";
import { DeviceRoleChoicePort } from "../features/role-choice/api";
import { RegionPrefSchema, type RegionPref, type RegionPrefPort } from "../features/welcome-region/model";
import type { Role, RoleChoicePort } from "../features/role-choice/model";
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
  /** First-screen role choice (shopper or brand), persisted per device. */
  readonly role: RoleChoicePort;
  /** First-run region and shop-for preference: device-local only, no server call, no analytics. */
  readonly region: RegionPrefPort;
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
  const tokens = new TokenStorage(storage);
  let cachedInstallId: string | null = null;
  const installId = async (): Promise<string> => {
    if (cachedInstallId !== null) return cachedInstallId;
    const existing = await storage.getString(STORAGE_KEYS.installId);
    if (existing !== null) return (cachedInstallId = existing);
    const fresh = randomUrlSafeId(32);
    await storage.setString(STORAGE_KEYS.installId, fresh);
    return (cachedInstallId = fresh);
  };
  // With EXPO_PUBLIC_API_BASE_URL set, every build talks to the real API through the generated client.
  const baseUrl = apiBaseUrlFromEnv();
  const runtime: ApiRuntime | null =
    baseUrl === null
      ? null
      : {
          baseUrl,
          tokens,
          installId,
          locale: () => (i18next.language?.startsWith("en") === true ? "en" : "ar"),
          platform: Platform.OS === "android" ? "android" : "ios",
        };
  configureApiRuntime(runtime);
  const api = createApi(clock, isDev, runtime);
  const ageGate = createAgeGate(clock, isDev, runtime);
  const consent = new ConsentController({
    clock,
    api,
    canSync: async () => (await tokens.load()) !== null,
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
  // First-party impression/view ingest. Off by default: the gate is BLOCKED until kill.analytics.ingest can be read
  // (no flag reader exists in the app yet) and VR-DASH-03 / VR-DASH-07 are resolved. Without a backend nothing is created.
  configureIngest(
    runtime === null
      ? null
      : {
          consent,
          gate: BLOCKED_GATE,
          transport: new FetchIngestTransport({ baseUrl: runtime.baseUrl, bearer: async () => (await tokens.load())?.accessToken ?? null, fetch: (u, i) => fetch(u, i) }),
          attest: { token: async () => (runtime.attest !== undefined ? await runtime.attest() : null) },
          clock,
          ids: { next: () => randomUrlSafeId(24) },
          random: () => { const j = randomUrlSafeId(2); return ((j.charCodeAt(0) * 256 + j.charCodeAt(1)) % 1000) / 1000; },
          sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
          timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) },
          platform: runtime.platform,
        },
  );
  consent.subscribe(() => getIngestEmitter()?.onConsentChanged());
  const loadSoftBlock = () => storage.getJson(STORAGE_KEYS.deviceSoftBlock, SoftBlockSchema);
  const role = new DeviceRoleChoicePort(
    { get: () => storage.getString(STORAGE_KEYS.rolePreference), set: (v) => storage.setString(STORAGE_KEYS.rolePreference, v) },
    runtime === null
      ? null
      : (r: Role) => getSharedClient(runtime).recordOnboardingPath({ body: { path: r } }),
    async () => (await tokens.load()) !== null,
  );
  const region: RegionPrefPort = {
    load: () => storage.getJson(STORAGE_KEYS.regionPreference, RegionPrefSchema),
    save: (p: RegionPref) => storage.setJson(STORAGE_KEYS.regionPreference, RegionPrefSchema.parse(p)),
    clear: () => storage.remove(STORAGE_KEYS.regionPreference),
  };
  return {
    api,
    role,
    region,
    ageGate,
    storage,
    tokens,
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

/** Like useServices but returns null outside a provider (tests, previews). Never throws. */
export function useOptionalServices(): AppServices | null {
  return useContext(ServicesContext);
}
