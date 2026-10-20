import { describe, expect, it } from "vitest";
import { SECRET_API_KEY, SECRET_LOGIN, type EgressProxyPort, type EgressProxyPostRequest, type EgressProxyPostResponse, type OdooHttpRequest } from "../domain/ports";
import { JsonVaultOdooSecretReader, MAX_REQUEST_BYTES, OdooEgressRefusedError, ProxiedOdooEgress } from "./proxied-egress";

const LOGIN = 'ops@shop-a.example"quote';
const KEY = "odoo-api-key-DO-NOT-LEAK-7f3a9";
const PUBLIC_IP = "93.184.216.34";

class Proxy implements EgressProxyPort {
  readonly calls: EgressProxyPostRequest[] = [];
  next: EgressProxyPostResponse | "throw" | "hang" = { status: 200, headers: { "content-type": "application/json", "set-cookie": "s=1" }, body: '{"result":1}', connectedAddress: PUBLIC_IP, truncated: false };
  async post(req: EgressProxyPostRequest): Promise<EgressProxyPostResponse> {
    this.calls.push(req);
    if (this.next === "throw") throw new Error(`connect ECONNREFUSED ${req.url} ${req.body}`);
    if (this.next === "hang") return new Promise(() => undefined);
    return this.next;
  }
}

const secrets = (fail = false) => {
  const reads: string[] = [];
  return {
    reads,
    port: {
      read: async (ref: string) => {
        reads.push(ref);
        if (fail) throw new Error("vault down");
        return { login: LOGIN, apiKey: KEY };
      },
    },
  };
};

const req = (over: Partial<OdooHttpRequest> = {}): OdooHttpRequest => ({
  url: "https://odoo.shop-a.com/jsonrpc",
  host: "odoo.shop-a.com",
  pinnedAddress: PUBLIC_IP,
  jsonBody: JSON.stringify({ params: { args: ["db", 7, SECRET_API_KEY], login: SECRET_LOGIN } }),
  tokenRef: "vault://odoo/a1",
  kmsKeyRef: "kms://k",
  maxBytes: 1024,
  ...over,
});

describe("ProxiedOdooEgress", () => {
  it("replaces placeholders after the vault read with JSON-escaped values and posts without redirects", async () => {
    const proxy = new Proxy();
    const s = secrets();
    const res = await new ProxiedOdooEgress(proxy, s.port).postJson(req());
    expect(s.reads).toEqual(["vault://odoo/a1"]);
    const sent = proxy.calls[0];
    expect(sent?.followRedirects).toBe(false);
    expect(sent?.pinnedAddress).toBe(PUBLIC_IP);
    expect(sent?.body).not.toContain("__ODOO_");
    const parsed = JSON.parse(sent?.body ?? "{}") as { params: { login: string; args: unknown[] } };
    expect(parsed.params.login).toBe(LOGIN);
    expect(parsed.params.args[2]).toBe(KEY);
    expect(res.status).toBe(200);
    expect(Object.keys(res.headers)).toEqual(["content-type"]);
  });

  it("refuses SSRF shapes before reading the vault", async () => {
    const proxy = new Proxy();
    const s = secrets();
    const egress = new ProxiedOdooEgress(proxy, s.port);
    for (const bad of [
      req({ url: "http://odoo.shop-a.com/jsonrpc" }),
      req({ url: "https://10.0.0.1/jsonrpc", host: "10.0.0.1" }),
      req({ url: "https://odoo.shop-a.com:8443/jsonrpc" }),
      req({ url: "https://other.example/jsonrpc" }),
      req({ pinnedAddress: "169.254.169.254" }),
      req({ pinnedAddress: "127.0.0.1" }),
      req({ jsonBody: "not json" }),
      req({ jsonBody: JSON.stringify({ pad: "x".repeat(MAX_REQUEST_BYTES) }) }),
    ]) {
      await expect(egress.postJson(bad)).rejects.toBeInstanceOf(OdooEgressRefusedError);
    }
    expect(s.reads).toEqual([]);
    expect(proxy.calls).toEqual([]);
  });

  it("fails closed without sending when the vault read fails, and never echoes secret or body in errors", async () => {
    const proxy = new Proxy();
    await expect(new ProxiedOdooEgress(proxy, secrets(true).port).postJson(req())).rejects.toMatchObject({ code: "secret_unavailable" });
    expect(proxy.calls).toEqual([]);

    proxy.next = "throw";
    const err = await new ProxiedOdooEgress(proxy, secrets().port).postJson(req()).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(OdooEgressRefusedError);
    expect((err as Error).message).not.toContain(KEY);
    expect((err as Error).message).not.toContain("odoo.shop-a.com");
  });

  it("times out, and flags an oversize or truncated body without returning it", async () => {
    const proxy = new Proxy();
    proxy.next = "hang";
    await expect(new ProxiedOdooEgress(proxy, secrets().port, { timeoutMs: 20 }).postJson(req())).rejects.toMatchObject({ code: "timeout" });

    proxy.next = { status: 200, headers: {}, body: "x".repeat(2000), connectedAddress: PUBLIC_IP, truncated: false };
    const big = await new ProxiedOdooEgress(proxy, secrets().port).postJson(req({ maxBytes: 1024 }));
    expect(big).toMatchObject({ truncated: true, body: "" });

    proxy.next = { status: 302, headers: { location: "https://169.254.169.254/" }, body: "", connectedAddress: PUBLIC_IP, truncated: false };
    const redirect = await new ProxiedOdooEgress(proxy, secrets().port).postJson(req());
    expect(redirect.status).toBe(302);
    expect(redirect.headers).toEqual({});
  });
});

describe("JsonVaultOdooSecretReader", () => {
  it("reads {login, api_key} and refuses missing or malformed secrets", async () => {
    const r = new JsonVaultOdooSecretReader(async (id) => (id === "odoo/a1" ? JSON.stringify({ login: "l", api_key: "k" }) : id === "bad" ? "[]" : null));
    expect(await r.read("vault://odoo/a1", "k")).toEqual({ login: "l", apiKey: "k" });
    await expect(r.read("vault://missing", "k")).rejects.toThrow();
    await expect(r.read("bad", "k")).rejects.toThrow();
  });
});
