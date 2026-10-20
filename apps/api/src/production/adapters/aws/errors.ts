import { ProblemError } from "../../../platform/problem";
import { ProviderNotConfiguredError, type ProviderName } from "../../unconfigured";

/** The provider answered with an error or timed out: 502, no provider detail leaks. */
export class ProviderUnavailableError extends ProblemError {
  constructor(
    readonly provider: ProviderName,
    readonly operation: string,
    readonly throttled = false,
  ) {
    super(502, "provider-unavailable", "A required provider is unavailable", {
      code: "provider_unavailable",
      detail: `Provider ${provider} is unavailable.`,
      headers: { "Retry-After": throttled ? "5" : "30" },
      extensions: { provider },
    });
    this.name = "ProviderUnavailableError";
  }
}

const THROTTLE = new Set(["ThrottlingException", "Throttling", "SlowDown", "RequestLimitExceeded", "TooManyRequestsException", "ProvisionedThroughputExceededException", "RequestThrottled", "LimitExceededException"]);
const NOT_CONFIGURED = new Set(["AccessDenied", "AccessDeniedException", "InvalidAccessKeyId", "SignatureDoesNotMatch", "NoSuchBucket", "NotFoundException", "CredentialsProviderError", "InvalidClientTokenId", "UnrecognizedClientException", "KMSInvalidStateException", "DisabledException", "ResourceNotFoundException"]);

function errName(e: unknown): string {
  if (typeof e === "object" && e !== null && "name" in e && typeof (e as { name: unknown }).name === "string") return (e as { name: string }).name;
  return "Error";
}

export function isThrottle(e: unknown): boolean {
  return THROTTLE.has(errName(e));
}

/** True when the object/secret simply does not exist (callers map it to null/false). */
export function isMissing(e: unknown): boolean {
  const n = errName(e);
  return n === "NoSuchKey" || n === "NotFound" || n === "NoSuchVersion" || n === "ResourceNotFoundException";
}

/** Maps an SDK error to a typed Problem. Misconfiguration (credentials, missing resources) is 503, everything else 502. */
export function mapAwsError(provider: ProviderName, operation: string, e: unknown): ProblemError {
  if (e instanceof ProblemError) return e;
  if (NOT_CONFIGURED.has(errName(e))) return new ProviderNotConfiguredError(provider, operation);
  return new ProviderUnavailableError(provider, operation, isThrottle(e));
}

export interface RetryOptions {
  readonly idempotent: boolean;
  readonly attempts?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Retries ONLY throttling errors, ONLY for idempotent operations, with exponential backoff and jitter. */
export async function callAws<T>(provider: ProviderName, operation: string, fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const max = opts.idempotent ? (opts.attempts ?? 3) : 1;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt < max && isThrottle(e)) {
        await sleep(Math.min(2000, 100 * 2 ** attempt) * (0.5 + Math.random() / 2));
        continue;
      }
      // Missing-resource errors reach the caller untouched so it can map them to null/false.
      if (isMissing(e)) throw e;
      throw mapAwsError(provider, operation, e);
    }
  }
}

/** Cheap reachability probe with a timeout. Never throws. */
export async function probe(fn: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    await fn(ac.signal);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
