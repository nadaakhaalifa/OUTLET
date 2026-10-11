import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { classifyIp, parseIpv4, parseIpv6, parseResolvedIp } from "./ip";
import { assertResolvedPublic, connectedAddressMatches, isPlausiblePublicDomain, validateEgressUrl, validateRedirect } from "./ssrf";

const V = new Set(["shop.example-store.com", "brand.eg"]);
const ok = (u: string) => validateEgressUrl(u, V);
const reason = (u: string) => {
  const r = ok(u);
  return r.ok ? "OK" : r.reason;
};
const blocked = (s: string): boolean => {
  const ip = parseResolvedIp(s);
  return ip === null || !classifyIp(ip).allowed;
};

describe("IP classification", () => {
  it.each([
    "169.254.169.254", "127.0.0.1", "10.0.0.1", "172.16.5.4", "172.31.255.255", "192.168.1.1", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00:ec2::254", "fc00::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "64:ff9b::a00:1", "2002:a9fe:a9fe::1", "ff02::1", "2001:db8::1", "::127.0.0.1",
  ])("blocks %s", (a) => {
    expect(blocked(a)).toBe(true);
  });
  it.each(["8.8.8.8", "93.184.216.34", "2606:4700:4700::1111", "172.32.0.1", "100.63.255.255"])("allows %s", (a) => {
    expect(blocked(a)).toBe(false);
  });
  it("decodes decimal, octal, hex and short IPv4 forms to the same address", () => {
    const meta = parseIpv4("169.254.169.254");
    expect(parseIpv4("2852039166")).toEqual(meta);
    expect(parseIpv4("0251.0376.0251.0376")).toEqual(meta);
    expect(parseIpv4("0xA9FEA9FE")).toEqual(meta);
    expect(parseIpv4("0xa9.0xfe.0xa9.0xfe")).toEqual(meta);
    expect(parseIpv4("169.254.43518")).toEqual(meta);
    expect(parseIpv4("127.1")).toEqual(parseIpv4("127.0.0.1"));
    expect(parseIpv4("256.1.1.1")).toBeNull();
    expect(parseIpv6("::ffff:1.2.3.4")?.version).toBe(6);
  });
  it("any IPv4 inside a forbidden private block is refused (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (a, b, c) => {
        expect(blocked(`10.${a}.${b}.${c}`)).toBe(true);
        expect(blocked(`192.168.${b}.${c}`)).toBe(true);
        expect(blocked(`127.${a}.${b}.${c}`)).toBe(true);
        expect(blocked(`169.254.${b}.${c}`)).toBe(true);
        expect(blocked(`172.${16 + (a % 16)}.${b}.${c}`)).toBe(true);
      }),
    );
  });
  it("an IPv4-mapped IPv6 is judged by its embedded IPv4 (property)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (b, c) => {
        expect(blocked(`::ffff:10.0.${b}.${c}`)).toBe(true);
        expect(blocked(`::ffff:8.8.${b}.${c}`)).toBe(false);
      }),
    );
  });
});

describe("validateEgressUrl", () => {
  it("accepts a verified domain and its subdomains, normalising case and trailing dot", () => {
    expect(ok("https://shop.example-store.com/p/1?x=2")).toMatchObject({ ok: true, target: { host: "shop.example-store.com", pathAndQuery: "/p/1?x=2" } });
    expect(ok("https://WWW.Brand.EG./a")).toMatchObject({ ok: true, target: { host: "www.brand.eg" } });
    expect(ok("https://brand.eg:443")).toMatchObject({ ok: true, target: { pathAndQuery: "/" } });
  });
  it("refuses everything the acceptance criteria name", () => {
    expect(reason("https://169.254.169.254/latest/meta-data")).toBe("ip_literal");
    expect(reason("https://2852039166/")).toBe("ip_literal");
    expect(reason("https://0251.0376.0251.0376/")).toBe("ip_literal");
    expect(reason("https://0xA9FEA9FE/")).toBe("ip_literal");
    expect(reason("https://[::1]/")).toBe("ip_literal");
    expect(reason("https://[fd00:ec2::254]/")).toBe("ip_literal");
    expect(reason("http://brand.eg/")).toBe("not_https");
    expect(reason("https://user:pw@brand.eg/")).toBe("userinfo");
    expect(reason("https://brand.eg@evil.com/")).toBe("userinfo");
    expect(reason("https://brand.eg:8443/")).toBe("bad_port");
    expect(reason("https://evil-brand.eg/")).toBe("domain_not_verified");
    expect(reason("https://brand.eg.evil.com/")).toBe("domain_not_verified");
    expect(reason("https://localhost/")).toBe("reserved_host");
    expect(reason("https://metadata.google.internal/")).toBe("reserved_host");
    expect(reason("https://brand.eg\\@evil.com/")).toBe("malformed");
    expect(reason("https://brand.eg/ x")).toBe("malformed");
    expect(reason("file:///etc/passwd")).toBe("not_https");
    expect(reason("https://bränd.eg/")).toBe("malformed");
  });
  it("re-validates every redirect and caps hops at 3", () => {
    const cur = { host: "brand.eg", pathAndQuery: "/a/b", url: "https://brand.eg/a/b" };
    expect(validateRedirect(cur, "/c", 1, V)).toMatchObject({ ok: true, target: { url: "https://brand.eg/c" } });
    expect(validateRedirect(cur, "d", 1, V)).toMatchObject({ ok: true, target: { url: "https://brand.eg/a/d" } });
    expect(validateRedirect(cur, "http://169.254.169.254/", 1, V)).toMatchObject({ ok: false });
    expect(validateRedirect(cur, "https://evil.com/", 1, V)).toMatchObject({ ok: false, reason: "domain_not_verified" });
    expect(validateRedirect(cur, "//evil.com/", 1, V)).toMatchObject({ ok: false });
    expect(validateRedirect(cur, "/c", 4, V)).toEqual({ ok: false, reason: "too_many_redirects" });
  });
  it("never accepts a host that is not in the verified set (property)", () => {
    fc.assert(
      fc.property(fc.domain(), (d) => {
        const r = validateEgressUrl(`https://${d}/`, new Set(["brand.eg"]));
        if (r.ok) expect(r.target.host === "brand.eg" || r.target.host.endsWith(".brand.eg")).toBe(true);
      }),
    );
  });
  it("plausible public domains", () => {
    expect(isPlausiblePublicDomain("shop.brand.eg")).toBe(true);
    for (const d of ["localhost", "a.local", "10.0.0.1", "brand", "x.internal", "-a.com"]) expect(isPlausiblePublicDomain(d)).toBe(false);
  });
});

describe("DNS rebinding guard", () => {
  it("refuses a name that resolves to a private address, alone or mixed with public ones", () => {
    expect(assertResolvedPublic(["10.0.0.1"])).toEqual({ ok: false, reason: "non_public_address" });
    expect(assertResolvedPublic(["93.184.216.34", "10.0.0.1"])).toEqual({ ok: false, reason: "non_public_address" });
    expect(assertResolvedPublic(["169.254.169.254"])).toMatchObject({ ok: false });
    expect(assertResolvedPublic([])).toEqual({ ok: false, reason: "no_addresses" });
    expect(assertResolvedPublic(["not-an-ip"])).toEqual({ ok: false, reason: "unparseable_address" });
    expect(assertResolvedPublic(["93.184.216.34", "2606:4700:4700::1111"])).toEqual({ ok: true, pinned: "93.184.216.34" });
  });
  it("the connected address must be the pinned public address", () => {
    expect(connectedAddressMatches("93.184.216.34", "93.184.216.34")).toBe(true);
    expect(connectedAddressMatches("93.184.216.34", "10.0.0.1")).toBe(false);
    expect(connectedAddressMatches("93.184.216.34", "::ffff:93.184.216.34")).toBe(false);
  });
});
