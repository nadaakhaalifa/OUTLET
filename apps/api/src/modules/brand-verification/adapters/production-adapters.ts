import { resolveTxt } from "node:dns/promises";
import { isIP } from "node:net";
import { ProblemError } from "../../../platform/problem";
import type {
  ApplicationOwnershipPort,
  DnsResolverPort,
  DnsTxtResult,
  SanctionsScreeningPort,
  TrademarkRegistryPort,
  VerificationEmailPort,
} from "../domain/ports";

/** Fail-closed 503 for a provider with no contract yet (ADR-0029 pattern). Never carries request data. */
export class BrandProviderNotConfiguredError extends ProblemError {
  constructor(readonly provider: string) {
    super(503, "provider-not-configured", "A required provider is not configured", {
      code: "provider_not_configured",
      detail: `Provider ${provider} is not configured on this deployment.`,
      headers: { "Retry-After": "300" },
      extensions: { provider },
    });
    this.name = "BrandProviderNotConfiguredError";
  }
}

export class UnconfiguredTrademarkRegistry implements TrademarkRegistryPort {
  async lookup(): Promise<never> {
    throw new BrandProviderNotConfiguredError("registry.trademark");
  }
}
export class UnconfiguredSanctionsScreening implements SanctionsScreeningPort {
  async screen(): Promise<never> {
    throw new BrandProviderNotConfiguredError("screening.sanctions");
  }
}
export class UnconfiguredVerificationEmail implements VerificationEmailPort {
  async sendCode(): Promise<never> {
    throw new BrandProviderNotConfiguredError("messaging.email");
  }
}
/** Until the sellers module supplies the real port every application route answers 503. */
export class UnconfiguredApplicationOwnership implements ApplicationOwnershipPort {
  async find(): Promise<never> {
    throw new BrandProviderNotConfiguredError("internal.sellers");
  }
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
/** TXT answers are data, not addresses, but the resolver must never be steered to an internal name server. */
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("dns_timeout")), ms).unref())]);

/** node:dns TXT lookups with a hard timeout. Only the validated `_zoutlet-verify.<registrable>` name is ever queried. */
export class NodeDnsResolver implements DnsResolverPort {
  constructor(private readonly timeoutMs = 3000) {}
  async resolveTxt(name: string): Promise<DnsTxtResult> {
    if (isIP(name) !== 0 || PRIVATE_V4.some((r) => r.test(name)) || !/^[a-z0-9._-]+(\.[a-z0-9-]+)+$/.test(name)) return { kind: "error" };
    try {
      const rows = await withTimeout(resolveTxt(name), this.timeoutMs);
      return { kind: "ok", answers: rows.map((chunks) => chunks.join("")) };
    } catch (e) {
      const code = (e as { code?: string }).code;
      return code === "ENOTFOUND" || code === "ENODATA" ? { kind: "nxdomain" } : { kind: "error" };
    }
  }
}
