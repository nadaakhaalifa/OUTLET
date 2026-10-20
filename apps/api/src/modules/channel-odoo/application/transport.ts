import type { z } from "zod";
import { RpcEnvelope } from "../domain/odoo";
import {
  MAX_RESPONSE_BYTES,
  MIN_REQUEST_GAP_MS,
  assertResolvedPublic,
  connectedAddressMatches,
  validateEgressUrl,
  type DomainPacer,
} from "../domain/egress";
import type {
  ChannelDirectoryPort,
  OdooClock,
  OdooDnsPort,
  OdooEgressPort,
  OdooErrorCode,
  OdooMetrics,
  OdooSleeper,
} from "../domain/ports";

export type RpcResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: OdooErrorCode };

export interface TransportDeps {
  readonly egress: OdooEgressPort;
  readonly dns: OdooDnsPort;
  readonly directory: ChannelDirectoryPort;
  readonly clock: OdooClock;
  readonly sleeper: OdooSleeper;
  readonly metrics: OdooMetrics;
  /** One pacer per worker process (per-domain politeness). */
  readonly pacer: DomainPacer;
}

/** A call that waits longer than this for its pacing slot is abandoned and retried on the next poll. */
const MAX_PACING_WAIT_MS = 60_000;
const OdooResult = RpcEnvelope;

/**
 * The only way this module reaches a seller's Odoo. Order: target is a verified domain of the same
 * store, URL validated (https, 443, no IP literals, host in the verified set), DNS resolved and
 * required to be public (pinned), per-domain pacing, redirects refused, DNS and connected address
 * re-checked after the call (rebinding), size cap, JSON-RPC envelope parsed.
 * The body carries placeholders only; the egress adapter injects the secret.
 */
export class OdooTransport {
  constructor(private readonly d: TransportDeps) {}

  async call(i: {
    readonly storeId: string;
    readonly targetId: string;
    readonly tokenRef: string;
    readonly kmsKeyRef: string;
    readonly body: string;
  }): Promise<RpcResult> {
    const target = await this.d.directory.verifiedTarget(i.storeId, i.targetId);
    if (target === null) return this.fail("ssrf_refused", "target_not_verified");
    const verified = new Set(await this.d.directory.verifiedDomains(i.storeId));
    if (!verified.has(target.domain)) return this.fail("ssrf_refused", "domain_not_verified");
    const url = validateEgressUrl(`https://${target.domain}/jsonrpc`, new Set([target.domain]));
    if (!url.ok) return this.fail("ssrf_refused", url.reason);

    const first = assertResolvedPublic(await this.d.dns.resolve(url.target.host).catch(() => []));
    if (!first.ok) return this.fail("dns_rebinding", first.reason);

    const now = this.d.clock.nowMs();
    const slot = this.d.pacer.reserve(target.domain, now, MIN_REQUEST_GAP_MS);
    if (slot - now > MAX_PACING_WAIT_MS) return this.fail("rate_limited", "pacing");
    if (slot > now) await this.d.sleeper.sleep(slot - now);

    let res;
    try {
      res = await this.d.egress.postJson({
        url: url.target.url,
        host: url.target.host,
        pinnedAddress: first.pinned,
        jsonBody: i.body,
        tokenRef: i.tokenRef,
        kmsKeyRef: i.kmsKeyRef,
        maxBytes: MAX_RESPONSE_BYTES,
      });
    } catch {
      return this.fail("network_error", "egress_threw");
    }
    const again = assertResolvedPublic(await this.d.dns.resolve(url.target.host).catch(() => []));
    if (!connectedAddressMatches(first.pinned, res.connectedAddress) || !again.ok || again.pinned !== first.pinned) {
      return this.fail("dns_rebinding", "connected_address_mismatch");
    }
    if (res.status >= 300 && res.status < 400) return this.fail("redirect_refused", String(res.status));
    if (res.truncated) return this.fail("size_exceeded", "truncated");
    if (res.status < 200 || res.status >= 300) return this.fail("http_error", String(res.status));

    let parsed: z.infer<typeof OdooResult>;
    try {
      const p = OdooResult.safeParse(JSON.parse(res.body));
      if (!p.success) return this.fail("bad_response", "envelope");
      parsed = p.data;
    } catch {
      return this.fail("bad_response", "not_json");
    }
    if (parsed.error !== undefined) return this.fail("rpc_error", "remote_error");
    if (parsed.result === undefined) return this.fail("bad_response", "no_result");
    return { ok: true, value: parsed.result };
  }

  private fail(code: OdooErrorCode, reason: string): RpcResult {
    this.d.metrics.increment("odoo_call_failed", { code, reason });
    return { ok: false, code };
  }
}
