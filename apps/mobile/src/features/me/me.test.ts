import { describe, expect, it } from "vitest";
import { groupedMeRows } from "../navigation/model";
import { InMemoryBrandModePort, getBrandModePort, maskPhone, modeSwitcher, profileView, setBrandModePort } from "./model";

describe("maskPhone", () => {
  it("masks all but the first two and last two national digits", () => {
    expect(maskPhone("+201012345678")).toBe("+20 10• ••• ••78");
    expect(maskPhone(null)).toBeNull();
    expect(maskPhone("garbage")).toBeNull();
  });
});

describe("profileView", () => {
  it("prefers the name and masks the phone", () => {
    const v = profileView({ displayName: " nada", phoneE164: "+201012345678", tier: "silver" });
    expect(v).toEqual({ initial: "N", title: "nada", maskedPhone: "+20 10• ••• ••78", tier: "silver", displayName: "nada", email: null, photoUrl: null });
  });
  it("falls back to the masked phone as the title", () => {
    const v = profileView({ displayName: null, phoneE164: "+201012345678", tier: null });
    expect(v.title).toBe("+20 10• ••• ••78");
    expect(v.maskedPhone).toBeNull();
  });
  it("never exposes the full phone", () => {
    expect(JSON.stringify(profileView({ displayName: null, phoneE164: "+201012345678", tier: null }))).not.toContain("1012345678");
  });
  it("handles Arabic initials and empty input", () => {
    expect(profileView({ displayName: "ندى", phoneE164: null, tier: null }).initial).toBe("ن");
    expect(profileView({ displayName: null, phoneE164: null, tier: null }).initial).toBe("");
  });
});

describe("brand mode", () => {
  it("hides the switcher without an approved brand (default fake returns none)", async () => {
    expect(modeSwitcher(await getBrandModePort().entry())).toBeNull();
  });
  it("shows it for an approved brand", async () => {
    setBrandModePort(new InMemoryBrandModePort({ brandId: "b1", name: "Mantle", status: "approved" }));
    expect(modeSwitcher(await getBrandModePort().entry())).toEqual(["shopping", "brand"]);
    setBrandModePort(null);
    expect(modeSwitcher(await getBrandModePort().entry())).toBeNull();
  });
});

describe("grouped Me rows", () => {
  it("makes three hairline groups and drops gift cards when off", () => {
    expect(groupedMeRows({ sales: true, redemption: true }).map((g) => g.length)).toEqual([4, 9, 3]);
    expect(groupedMeRows(null).map((g) => g.length)).toEqual([4, 8, 3]);
  });
});

import { resources } from "@outlet/i18n";
import { visibleMeRows } from "../navigation/model";

const RAW_KEY = /^[a-z]+\.[a-zA-Z.]+$/;
const lookup = (tree: unknown, key: string): unknown =>
  key.split(".").reduce<unknown>((n, k) => (typeof n === "object" && n !== null ? (n as Record<string, unknown>)[k] : undefined), tree);

describe("Me strings are real copy, never raw keys", () => {
  const keys = [
    "me.title", "me.guest", "me.tier", "me.signOut", "me.mode.shopping", "me.mode.brand", "me.menuLabel",
    ...visibleMeRows({ sales: true, redemption: true }).flatMap((r) => [r.titleKey, ...(r.hintKey !== undefined ? [r.hintKey] : [])]),
    "rewards.tier.bronze", "rewards.tier.silver", "rewards.tier.gold", "rewards.tier.black",
  ];
  for (const lang of ["en", "ar"] as const) {
    it(`resolves every key in ${lang}`, () => {
      for (const k of keys) {
        const v = lookup(resources[lang], k);
        expect(typeof v, k).toBe("string");
        expect(RAW_KEY.test(String(v)), k).toBe(false);
      }
    });
  }
});

import { signOut } from "./model";

describe("signOut", () => {
  it("revokes remotely then clears locally", async () => {
    const calls: string[] = [];
    const r = await signOut({ revokeRemote: async () => { calls.push("remote"); }, clearLocal: async () => { calls.push("local"); } });
    expect(calls).toEqual(["remote", "local"]);
    expect(r.remoteRevoked).toBe(true);
  });
  it("still clears locally when the server is unreachable", async () => {
    let cleared = false;
    const r = await signOut({ revokeRemote: async () => { throw new Error("offline"); }, clearLocal: async () => { cleared = true; } });
    expect(cleared).toBe(true);
    expect(r.remoteRevoked).toBe(false);
  });
  it("clears locally in fake mode", async () => {
    let cleared = false;
    const r = await signOut({ revokeRemote: null, clearLocal: async () => { cleared = true; } });
    expect(cleared && r.remoteRevoked).toBe(true);
  });
});
