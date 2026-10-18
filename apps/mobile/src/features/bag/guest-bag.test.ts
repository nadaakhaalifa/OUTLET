import { describe, expect, it } from "vitest";
import { InMemoryGuestStorage, GuestStore } from "../guest";
import { GuestBagPort, type SkuLiveReader } from "./guest-bag";
import { BagCapError, buildBag, changeHeadline, type AddLineHint, type BagPort, type BagSnapshot } from "./model";
import { SessionBagPort } from "./session-bag";

const T0 = 1_700_000_000_000;
let n = 0;
const mk = async () => { const s = new GuestStore(new InMemoryGuestStorage(), { now: () => T0, newLineId: () => `l${++n}` }); await s.hydrate(); return s; };
const hint = (o: Partial<AddLineHint> = {}): AddLineHint => ({ storeId: "st1", storeName: "Store One", title: "Dress", sizeLabel: "M", unitPrice: 10_000n, ...o });

describe("GuestBagPort", () => {
  it("adds, groups by store and reads back from the device store", async () => {
    const s = await mk();
    const p = new GuestBagPort(s);
    await p.addLine("sku1", hint());
    await p.addLine("sku2", hint({ storeId: "st2", storeName: "Store Two" }));
    const snap = await p.load();
    expect(snap.guest).toBe(true);
    expect(snap.isPlusMember).toBe(false);
    expect(snap.stores.map((x) => x.name)).toEqual(["Store One", "Store Two"]);
    expect(snap.lines).toHaveLength(2);
    // no threshold from a public read: no free-delivery progress is invented
    expect(buildBag(snap).groups.every((g) => g.freeDelivery.threshold === 0n)).toBe(true);
    expect(await p.inSizeSuggestions("st1")).toEqual([]);
  });

  it("shows price moves honestly in both directions, and last-seen prices when the read fails", async () => {
    const s = await mk();
    const live = new Map([["sku1", { unitPrice: 9_000n, available: true, storeOpen: true }], ["sku2", { unitPrice: 12_000n, available: true, storeOpen: true }]]);
    const p = new GuestBagPort(s, { read: async () => live });
    await p.addLine("sku1", hint());
    await p.addLine("sku2", hint());
    const lines = (await p.load()).lines;
    expect(changeHeadline({ kind: "dropped", delta: lines[0]!.priceAtAdd - lines[0]!.unitPrice })).toMatchObject({ direction: "dropped", delta: 1_000n });
    expect(lines[1]!.unitPrice - lines[1]!.priceAtAdd).toBe(2_000n);
    const offline = new GuestBagPort(s, { read: async () => { throw new Error("offline"); } });
    const l2 = (await offline.load()).lines;
    expect(l2.every((l) => l.unitPrice === l.priceAtAdd)).toBe(true);
    const snap = await offline.load();
    expect(snap.offline).toBe(true);
    expect(snap.lines.every((l) => l.priceStale === true && l.seenAt === T0)).toBe(true);
    expect((await p.load()).offline).toBeUndefined();
  });

  it("marks sold-out SKUs and suspended stores from the live read", async () => {
    const s = await mk();
    const reader: SkuLiveReader = { read: async () => new Map([["sku1", { unitPrice: 10_000n, available: false, storeOpen: false }]]) };
    const p = new GuestBagPort(s, reader);
    await p.addLine("sku1", hint());
    const snap = await p.load();
    expect(snap.lines[0]?.availability).toBe("soldOut");
    expect(snap.stores[0]?.status).toBe("suspended");
  });

  it("quantity change, save for later and remove write to the device store", async () => {
    const s = await mk();
    const p = new GuestBagPort(s);
    await p.addLine("sku1", hint());
    const id = (await p.load()).lines[0]!.id;
    await p.setQuantity(id, 4);
    await p.setSavedForLater(id, true);
    expect(s.getState().bag[0]).toMatchObject({ qty: 4, savedForLater: true });
    await p.removeLine(id);
    expect(s.getState().bag).toHaveLength(0);
  });

  it("refuses the 11th unit and the 51st line with a cap error", async () => {
    const s = await mk();
    const p = new GuestBagPort(s);
    await p.addLine("sku1", hint());
    const id = (await p.load()).lines[0]!.id;
    await expect(p.setQuantity(id, 11)).rejects.toMatchObject({ cap: "units" });
    for (let i = 2; i <= 50; i++) await p.addLine(`sku${i}`, hint());
    const err = await p.addLine("sku51", hint()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BagCapError);
    expect((err as BagCapError).cap).toBe("lines");
    expect(s.getState().bag).toHaveLength(50);
  });
});

describe("SessionBagPort", () => {
  const snap = (tag: string): BagSnapshot => ({ stores: [], lines: [], isPlusMember: false, ...(tag === "guest" ? { guest: true } : {}) });
  const fake = (tag: string, log: string[]): BagPort => ({
    load: async () => { log.push(`${tag}.load`); return snap(tag); },
    inSizeSuggestions: async () => [], setSavedForLater: async () => undefined, setQuantity: async () => undefined,
    removeLine: async () => { log.push(`${tag}.remove`); }, addLine: async () => { log.push(`${tag}.add`); },
  });

  it("signed out uses the guest bag and never retries a merge", async () => {
    const log: string[] = [];
    const p = new SessionBagPort(fake("server", log), fake("guest", log), async () => false, async () => { log.push("merge"); });
    expect((await p.load()).guest).toBe(true);
    await p.addLine("x", hint());
    expect(log).toEqual(["guest.load", "guest.add"]);
  });
  it("signed in retries a pending merge, then uses the server bag", async () => {
    const log: string[] = [];
    const p = new SessionBagPort(fake("server", log), fake("guest", log), async () => true, async () => { log.push("merge"); });
    await p.load();
    await p.removeLine("x");
    expect(log).toEqual(["merge", "server.load", "server.remove"]);
  });
  it("a failed merge retry never blocks the bag", async () => {
    const log: string[] = [];
    const p = new SessionBagPort(fake("server", log), fake("guest", log), async () => true, async () => { throw new Error("down"); });
    await expect(p.load()).resolves.toBeDefined();
  });
});
