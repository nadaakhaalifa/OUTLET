import { MAX_RESPONSE_BYTES, assertResolvedPublic, validateEgressUrl } from "../domain/egress";
import {
  SECRET_API_KEY,
  SECRET_LOGIN,
  type EgressProxyPort,
  type OdooEgressPort,
  type OdooHttpRequest,
  type OdooHttpResponse,
  type OdooSecretReaderPort,
} from "../domain/ports";

/** Largest JSON-RPC request this adapter will send (a poll asks for at most a few hundred product ids). */
export const MAX_REQUEST_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Thrown for a request this adapter refuses. The message is a fixed code; it never carries request data. */
export class OdooEgressRefusedError extends Error {
  constructor(readonly code: string) {
    super(`odoo egress refused: ${code}`);
    this.name = "OdooEgressRefusedError";
  }
}

const jsonEscape = (v: string): string => JSON.stringify(v).slice(1, -1);

/**
 * Production OdooEgressPort. Order of operations:
 *   1. re-validate the target with the shared SSRF guard (https, 443, no IP literal, host equals the
 *      verified host the caller resolved) and require the pinned address to be public;
 *   2. require a JSON body of bounded size;
 *   3. only now read the secret from the vault and replace the placeholders (JSON-escaped), so a
 *      refused request never touches the vault;
 *   4. POST through the allow-listed proxy with no redirects, a timeout and a response size cap.
 * Any proxy failure is rethrown as a fixed, secret-free error (the transport counts it as a network error).
 */
export class ProxiedOdooEgress implements OdooEgressPort {
  constructor(
    private readonly proxy: EgressProxyPort,
    private readonly secrets: OdooSecretReaderPort,
    private readonly opts: { readonly timeoutMs?: number; readonly maxResponseBytes?: number } = {},
  ) {}

  async postJson(req: OdooHttpRequest): Promise<OdooHttpResponse> {
    const url = validateEgressUrl(req.url, new Set([req.host]));
    if (!url.ok || url.target.host !== req.host.toLowerCase() || url.target.url !== req.url) throw new OdooEgressRefusedError("target");
    if (!assertResolvedPublic([req.pinnedAddress]).ok) throw new OdooEgressRefusedError("address");
    if (Buffer.byteLength(req.jsonBody, "utf8") > MAX_REQUEST_BYTES) throw new OdooEgressRefusedError("request_size");
    try {
      JSON.parse(req.jsonBody);
    } catch {
      throw new OdooEgressRefusedError("not_json");
    }

    let body: string;
    try {
      const s = await this.secrets.read(req.tokenRef, req.kmsKeyRef);
      body = req.jsonBody.split(SECRET_LOGIN).join(jsonEscape(s.login)).split(SECRET_API_KEY).join(jsonEscape(s.apiKey));
    } catch {
      throw new OdooEgressRefusedError("secret_unavailable");
    }

    const cap = Math.min(req.maxBytes, this.opts.maxResponseBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OdooEgressRefusedError("timeout")), timeoutMs);
    });
    try {
      const res = await Promise.race([
        this.proxy.post({
          url: url.target.url,
          host: url.target.host,
          pinnedAddress: req.pinnedAddress,
          headers: { "content-type": "application/json", accept: "application/json" },
          body,
          timeoutMs,
          maxResponseBytes: cap,
          followRedirects: false,
        }),
        timeout,
      ]);
      const oversize = res.truncated || Buffer.byteLength(res.body, "utf8") > cap;
      return {
        status: res.status,
        // Only the headers the transport needs; cookies and location are never passed up.
        headers: Object.fromEntries(Object.entries(res.headers).filter(([k]) => k.toLowerCase() === "content-type")),
        body: oversize ? "" : res.body,
        connectedAddress: res.connectedAddress,
        truncated: oversize,
      };
    } catch (e) {
      if (e instanceof OdooEgressRefusedError) throw e;
      throw new OdooEgressRefusedError("proxy_failed");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** Vault reader: the secret reference maps to a secret id; the value is JSON `{login, api_key}`. */
export class JsonVaultOdooSecretReader implements OdooSecretReaderPort {
  constructor(private readonly getSecret: (secretId: string) => Promise<string | null>) {}

  async read(tokenRef: string, _kmsKeyRef: string): Promise<{ login: string; apiKey: string }> {
    const id = tokenRef.startsWith("vault://") ? tokenRef.slice("vault://".length) : tokenRef;
    if (id.length === 0) throw new Error("secret_ref_invalid");
    const raw = await this.getSecret(id);
    if (raw === null) throw new Error("secret_missing");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("secret_shape");
    const o = parsed as Record<string, unknown>;
    const login = o["login"];
    const apiKey = o["api_key"];
    if (typeof login !== "string" || typeof apiKey !== "string" || login.length === 0 || apiKey.length === 0) throw new Error("secret_shape");
    return { login, apiKey };
  }
}
