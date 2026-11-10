import { describe, expect, it } from "vitest";
import { assertSafeTarget, isPublicIp } from "../src/index.js";

describe("isPublicIp edge forms", () => {
  it("rejects every reserved IPv4 block boundary and accepts the neighbours", () => {
    for (const ip of ["0.1.2.3", "10.255.255.255", "127.0.0.1", "224.0.0.1", "255.255.255.255", "100.64.0.1", "100.127.255.255", "169.254.1.1", "172.16.0.1", "172.31.255.255",
      "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.19.255.1", "198.51.100.7", "203.0.113.9"]) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ["100.63.255.255", "172.15.0.1", "192.0.1.1", "192.169.0.1", "198.17.0.1", "198.51.101.1", "203.0.112.1", "223.255.255.255", "11.0.0.1"]) expect(isPublicIp(ip), ip).toBe(true);
  });
  it("rejects malformed addresses and IPv4 shapes", () => {
    for (const ip of ["", "1.2.3.4.5", "256.1.1.1", "01.2.3", "::ffff:999.1.1.1", "1::2::3", "12345::1", "1:2:3:4:5:6:7:8:9", "g::1", "[::1]"]) expect(isPublicIp(ip), ip).toBe(false);
  });
  it("classifies IPv6 prefixes", () => {
    for (const ip of ["0:0:0:0:0:0:0:0", "0:0:0:0:0:0:0:1", "fe80::1%eth0", "febf::1", "fc00::1", "fdff::1", "ff00::1", "2001:db8::1", "2001::1", "2002::1", "64:ff9b::1", "100::1", "::ffff:192.168.0.1", "::10.0.0.1"]) expect(isPublicIp(ip), ip).toBe(false);
    for (const ip of ["2001:4860::1", "2001:1::1", "100:0:0:1::1", "100:1::1", "2a00:1450::1", "1::", "::8.8.8.8", "::ffff:8.8.4.4", "2606:4700:4700::1111", "0:0:0:0:0:ffff:808:808"]) expect(isPublicIp(ip), ip).toBe(true);
  });
  it("assertSafeTarget refuses IPv6 literal hosts and trailing-dot lookalikes outside the verified domain", async () => {
    const dns = { resolve: () => Promise.resolve(["93.184.216.34"]) };
    const o = { dns, allowedDomains: ["shop.example.com"] };
    await expect(assertSafeTarget("https://[2606:4700::1111]/", o)).rejects.toMatchObject({ code: "unsafe_target" });
    await expect(assertSafeTarget("https://notshop.example.com/", o)).rejects.toMatchObject({ code: "unsafe_target" });
    await expect(assertSafeTarget("https://shop.example.com.evil.com/", o)).rejects.toMatchObject({ code: "unsafe_target" });
    expect((await assertSafeTarget("https://SHOP.example.com./x", o)).address).toBe("93.184.216.34");
    await expect(assertSafeTarget("https://shop.example.com/", { dns: { resolve: () => Promise.resolve([]) }, allowedDomains: ["shop.example.com"] })).rejects.toThrow(/did not resolve/);
  });
});
