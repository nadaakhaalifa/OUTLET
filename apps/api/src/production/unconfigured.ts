import { ProblemError } from "../platform/problem";

/**
 * Names of every external provider and internal wiring the API can need. A provider is bound to an
 * explicit `Unconfigured` adapter until a real adapter exists AND the operator configures it
 * (ADR-0029). Names only appear in logs and in /v1/ready, never credentials.
 */
export const PROVIDERS = {
  "psp.paymob": { kind: "external", note: "Paymob/Kashier PSP (VR-F1-04)" },
  "psp.recurring": { kind: "external", note: "PSP tokenised recurring charges (VR rows 4, 10)" },
  "psp.b2b-intents": { kind: "external", note: "PSP B2B payment intents for ads" },
  "payout.rail": { kind: "external", note: "Bank or PSP payout rail (ADR-0019)" },
  "bank.name-match": { kind: "external", note: "IBAN holder-name inquiry" },
  "settlement.files": { kind: "external", note: "PSP, courier and BNPL settlement files" },
  "bnpl.quotes": { kind: "external", note: "BNPL lender quote and cancel APIs (FRA)" },
  "courier.bosta": { kind: "external", note: "Bosta API (VR-11)" },
  "courier.aramex": { kind: "external", note: "Aramex API via egress proxy (VR-11)" },
  "eta.portal": { kind: "external", note: "ETA e-invoice and e-receipt portal (VR-06)" },
  "messaging.sms-whatsapp": { kind: "external", note: "SMS and WhatsApp business provider" },
  "messaging.email": { kind: "external", note: "Transactional and marketing email provider" },
  "push.apns-fcm": { kind: "external", note: "APNs and FCM push" },
  "llm.gateway-provider": { kind: "external", note: "LLM vendor (VR-02 transfer licence)" },
  "kms.envelope": { kind: "external", note: "KMS envelope field encryption and HMAC keys (ADR-0002)" },
  "secrets.manager": { kind: "external", note: "Secret manager for provider credentials" },
  "object.store": { kind: "external", note: "S3-compatible object store" },
  "attestation.app-attest": { kind: "external", note: "App Attest and Play Integrity verifier" },
  "flags.provider": { kind: "external", note: "Feature flag provider (OpenFeature self-hosted)" },
  "queue.redis": { kind: "external", note: "Redis queue for the waiting room (VR-16)" },
  "search.typesense": { kind: "external", note: "Typesense search index" },
  "crawler.egress": { kind: "external", note: "Crawler egress proxy, DNS, parser" },
  "moderation.classifier": { kind: "external", note: "Image and text moderation classifier" },
  "analytics.warehouse": { kind: "external", note: "ClickHouse event source" },
  "internal.wiring": { kind: "internal", note: "Cross-module port with no adapter composed yet" },
} as const;

export type ProviderName = keyof typeof PROVIDERS;

/**
 * Thrown at CALL time by every Unconfigured adapter. Extending ProblemError means the global
 * ProblemFilter answers 503 with Problem+JSON code `provider_not_configured`; the message never
 * carries request data.
 */
export class ProviderNotConfiguredError extends ProblemError {
  constructor(
    readonly provider: ProviderName,
    readonly operation: string,
  ) {
    super(503, "provider-not-configured", "A required provider is not configured", {
      code: "provider_not_configured",
      detail: `Provider ${provider} is not configured on this deployment.`,
      headers: { "Retry-After": "300" },
      extensions: { provider },
    });
    this.name = "ProviderNotConfiguredError";
  }
}

/** Introspection and Nest lifecycle hooks must look absent, or the container would "call" them at boot. */
const PASS_THROUGH = new Set<string | symbol>([
  "then",
  "toJSON",
  "constructor",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
  "tagName",
  "onModuleInit",
  "onApplicationBootstrap",
  "onModuleDestroy",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
]);

const bound = new Set<ProviderName>();
const realProbes = new Map<ProviderName, (() => Promise<boolean>) | null>();

/** Records a provider bound to a REAL adapter, with an optional cheap reachability probe for /v1/ready. */
export function markConfigured(provider: ProviderName, probe: (() => Promise<boolean>) | null = null): void {
  realProbes.set(provider, probe);
}

/** Status for /v1/ready: configured (real adapter, reachable or unprobed), unreachable (probe failed) or unconfigured. */
export async function providerStatus(provider: ProviderName): Promise<"configured" | "unreachable" | "unconfigured"> {
  if (!realProbes.has(provider)) return "unconfigured";
  const p = realProbes.get(provider);
  if (p === null || p === undefined) return "configured";
  return (await p()) ? "configured" : "unreachable";
}

export function isRealProvider(provider: ProviderName): boolean {
  return realProbes.has(provider);
}

/** Providers that have been bound to an Unconfigured adapter in this process (names only). */
export function boundUnconfigured(): readonly ProviderName[] {
  return [...bound].sort();
}

/** Records a provider that is Unconfigured by a means other than the generic adapter (flag provider, search transport). */
export function markUnconfigured(provider: ProviderName): void {
  bound.add(provider);
}

/** Test helper: the registry is process-global so that /v1/ready can list it. */
export function resetBoundUnconfigured(): void {
  bound.clear();
  realProbes.clear();
}

/**
 * Explicit Unconfigured adapter for any port. Every method call throws ProviderNotConfiguredError;
 * nothing ever returns a value that looks like success. `fixed` supplies the few static,
 * non-behavioural properties some ports expose (an id, a method list).
 */
export function unconfigured<T extends object>(provider: ProviderName, fixed: Partial<T> = {}): T {
  bound.add(provider);
  const target: Record<string | symbol, unknown> = { ...fixed };
  return new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(t, prop)) return t[prop];
      if (typeof prop === "symbol" || PASS_THROUGH.has(prop)) return undefined;
      return (): never => {
        throw new ProviderNotConfiguredError(provider, prop);
      };
    },
  }) as unknown as T;
}
