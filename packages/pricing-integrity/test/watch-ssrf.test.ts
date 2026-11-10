import { describe, expect, it } from "vitest";
import { DomainRateLimiter, MAX_REDIRECTS, assertSafeTarget, isPublicIp, safeFetch } from "../src/index.js";
import type { ChannelFetchPort, FetchResponse } from "../src/index.js";

const dnsOf = (m: Record<string, string[]>) => ({ resolve: (h: string) => Promise.resolve(m[h] ?? []) });
const PUB = "93.184.216.34";
const o = (m: Record<string, string[]>) => ({ dns: dnsOf(m), allowedDomains: ["shop.example.com"] });
const base = { userAgent: "ua", timeoutMs: 1000 };

describe("isPublicIp", () => {
  it("rejects private, loopback, link-local, CGNAT, multicast, documentation and mapped addresses", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "0.1.2.3", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1", "100.64.0.1", "198.18.0.1", "198.51.100.1", "203.0.113.5", "192.0.2.1", "192.0.0.1", "224.0.0.1", "255.255.255.255",
      "::", "::1", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1", "64:ff9b::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::ffff:127.0.0.1", "not-an-ip", "1.2.3"]) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of [PUB, "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8", "2001:4860:4860::8888"]) expect(isPublicIp(ip), ip).toBe(true);
  });
});

describe("assertSafeTarget", () => {
  const ok = { "shop.example.com": [PUB], "www.shop.example.com": [PUB] };
  it("accepts a verified domain and its subdomain, pinning the resolved address", async () => {
    expect((await assertSafeTarget("https://shop.example.com/products.json", o(ok))).address).toBe(PUB);
    expect((await assertSafeTarget("https://www.shop.example.com:443/x", o(ok))).url.hostname).toBe("www.shop.example.com");
  });
  it("refuses everything else", async () => {
    const bad = ["http://shop.example.com/", "https://u:p@shop.example.com/", "https://shop.example.com:8443/", "https://127.0.0.1/", "https://[::1]/", "https://0x7f.1/", "https://2130706433/", "https://evil.com/", "https://notshop.example.com.evil.com/", "nope", "https://xshop.example.com/"];
    for (const u of bad) await expect(assertSafeTarget(u, o({ ...ok, "evil.com": [PUB] })), u).rejects.toMatchObject({ code: "unsafe_target" });
  });
  it("refuses a host that resolves to a private address, to any private address among several (rebinding), or to nothing", async () => {
    await expect(assertSafeTarget("https://shop.example.com/", o({ "shop.example.com": ["10.0.0.5"] }))).rejects.toThrow(/non-public/);
    await expect(assertSafeTarget("https://shop.example.com/", o({ "shop.example.com": [PUB, "169.254.169.254"] }))).rejects.toThrow(/non-public/);
    await expect(assertSafeTarget("https://shop.example.com/", o({}))).rejects.toThrow(/did not resolve/);
  });
});

describe("safeFetch", () => {
  const dns = { "shop.example.com": [PUB], "a.shop.example.com": [PUB], "internal.shop.example.com": ["10.1.1.1"] };
  const portOf = (responses: FetchResponse[]): ChannelFetchPort & { urls: string[] } => {
    const urls: string[] = [];
    return { urls, fetch: (r) => { urls.push(`${r.url}@${r.address}`); return Promise.resolve(responses.shift() ?? { status: 200, items: [] }); } };
  };
  it("follows a redirect inside the verified domain and sends the pinned address", async () => {
    const p = portOf([{ status: 301, location: "/b", items: [] }, { status: 200, items: [] }]);
    expect((await safeFetch(p, "https://shop.example.com/a", o(dns), base)).status).toBe(200);
    expect(p.urls).toEqual([`https://shop.example.com/a@${PUB}`, `https://shop.example.com/b@${PUB}`]);
  });
  it("refuses a redirect to a private host, to another domain, with no location, and loops", async () => {
    await expect(safeFetch(portOf([{ status: 302, location: "https://internal.shop.example.com/", items: [] }]), "https://shop.example.com/", o(dns), base)).rejects.toThrow(/non-public/);
    await expect(safeFetch(portOf([{ status: 302, location: "http://169.254.169.254/latest", items: [] }]), "https://shop.example.com/", o(dns), base)).rejects.toThrow(/https/);
    await expect(safeFetch(portOf([{ status: 302, location: "https://evil.com/", items: [] }]), "https://shop.example.com/", o(dns), base)).rejects.toThrow(/verified domain/);
    await expect(safeFetch(portOf([{ status: 302, items: [] }]), "https://shop.example.com/", o(dns), base)).rejects.toThrow(/location/);
    await expect(safeFetch(portOf(Array.from({ length: MAX_REDIRECTS + 2 }, () => ({ status: 302, location: "/x", items: [] }))), "https://shop.example.com/", o(dns), base)).rejects.toThrow(/too many/);
  });
  it("returns 304 and 4xx without following", async () => {
    expect((await safeFetch(portOf([{ status: 304, items: [] }]), "https://shop.example.com/", o(dns), base)).status).toBe(304);
    expect((await safeFetch(portOf([{ status: 404, items: [] }]), "https://shop.example.com/", o(dns), base)).status).toBe(404);
  });
});

describe("DomainRateLimiter (injected clock)", () => {
  it("allows one request per 5 s per domain and domains are independent", () => {
    const l = new DomainRateLimiter();
    expect(l.reserve("a.com", 1000)).toBe(0);
    expect(l.reserve("a.com", 1000)).toBe(5000);
    expect(l.reserve("a.com", 2000)).toBe(9000);
    expect(l.reserve("b.com", 1000)).toBe(0);
    expect(l.reserve("a.com", 100_000)).toBe(0);
    expect(new DomainRateLimiter(1000).reserve("x", 5)).toBe(0);
  });
});
