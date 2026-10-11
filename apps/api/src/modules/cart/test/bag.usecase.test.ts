import { describe, expect, it } from "vitest";
import { money } from "../domain/bridge";
import { AddLine, GetCart, UpdateLine, RemoveLine, type BagDeps } from "../application/bag";
import { FakeCatalog } from "../adapters/fake-catalog";
import {
  InMemoryCartEventPublisher,
  InMemoryCartRepository,
  StaticMembership,
  StaticPlatformConfig,
} from "../adapters/in-memory";
import type { CartRecord, CartRepository } from "../domain/ports";
import { uid } from "./cart-harness";

function deps(repo: CartRepository = new InMemoryCartRepository()) {
  const catalog = new FakeCatalog();
  const store = uid(1);
  catalog.addStore(store);
  const skuId = uid(2);
  catalog.addSku({ skuId, productId: uid(3), storeId: store, title: { ar: "ت" }, unitPrice: money(10_000n), available: true });
  const d: BagDeps = {
    repo,
    catalog,
    membership: new StaticMembership(),
    platform: new StaticPlatformConfig(),
    events: new InMemoryCartEventPublisher(),
    clock: { nowMs: () => 1_800_000_000_000 },
    ids: { uuidV7: () => uid(8) },
  };
  return { d, skuId, store };
}

class AlwaysStale extends InMemoryCartRepository {
  saves = 0;
  override async save(_c: CartRecord, _v: number, _n: number): Promise<boolean> {
    this.saves += 1;
    return false;
  }
}

describe("optimistic concurrency", () => {
  it("retries three times then reports a conflict, never half-writing", async () => {
    const repo = new AlwaysStale();
    const { d, skuId } = deps(repo);
    const r = await new AddLine(d).execute({ userId: uid(6), skuId, qty: 1, source: null });
    expect(r.kind).toBe("conflict");
    expect(repo.saves).toBe(3);
    expect((await new GetCart(d).execute(uid(6))).lineCount).toBe(0);
  });

  it("update and remove also report a conflict and unknown lines as not_found", async () => {
    const repo = new AlwaysStale();
    const { d } = deps(repo);
    const user = uid(6);
    expect((await new UpdateLine(d).execute({ userId: user, lineId: uid(4), qty: 2 })).kind).toBe("not_found");
    expect((await new RemoveLine(d).execute({ userId: user, lineId: uid(4) })).kind).toBe("not_found");
  });

  it("a losing writer retries against fresh state and succeeds", async () => {
    const repo = new InMemoryCartRepository();
    const { d, skuId } = deps(repo);
    const user = uid(6);
    await repo.getOrCreate(user, uid(9), 0);
    let first = true;
    const original = repo.save.bind(repo);
    repo.save = async (c, v, n) => {
      if (first) {
        first = false;
        repo.bumpVersionForTest(user);
      }
      return original(c, v, n);
    };
    const r = await new AddLine(d).execute({ userId: user, skuId, qty: 1, source: "pdp" });
    expect(r.kind).toBe("ok");
  });
});

describe("validation at the use-case boundary", () => {
  it("throws on a non-integer quantity instead of pricing it", async () => {
    const { d, skuId } = deps();
    await expect(new AddLine(d).execute({ userId: uid(6), skuId, qty: 0, source: null })).rejects.toThrow();
    await expect(new UpdateLine(d).execute({ userId: uid(6), lineId: uid(4), qty: 11 })).rejects.toThrow();
  });
});
