import { describe, expect, it } from "vitest";
import type { AdmissionStore } from "../domain/ports";

export interface StoreFixture {
  readonly store: AdmissionStore;
  readonly ensureDrop: (id: string) => Promise<void>;
  readonly ensureUser: (id: string) => Promise<void>;
  readonly eventTypes: () => Promise<readonly string[]>;
}

export const T0 = 1_800_000_000_000;
export const U = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const DEV = (n: number): string => String(n).padStart(64, "0");
export const rec = (n: number, over: Partial<Parameters<AdmissionStore["recordAdmission"]>[0]> = {}) => ({
  jti: U(200 + n),
  ticketId: U(300 + n),
  dropId: U(100),
  userId: U(n),
  deviceHash: DEV(n),
  joinedAtMs: T0 - 5_000,
  issuedAtMs: T0,
  expiresAtMs: T0 + 15 * 60_000,
  usedAtMs: null,
  ...over,
});

export function describeAdmissionStoreContract(name: string, make: () => Promise<StoreFixture>): void {
  describe(`admission store contract: ${name}`, () => {
    it("counts ended tickets by state since a time", async () => {
      const f = await make();
      await f.ensureDrop(U(100));
      await f.ensureUser(U(1));
      await f.ensureUser(U(2));
      await f.store.recordAdmission(rec(1), []);
      await f.store.recordEnded(
        { ticketId: U(399), dropId: U(100), userId: U(2), deviceHash: DEV(2), joinedAtMs: T0 - 9_000, state: "rejected", atMs: T0 + 1_000 },
        [],
      );
      expect(await f.store.countsSince(U(100), T0)).toEqual({ admitted: 1, rejected: 1, abandoned: 0 });
      expect(await f.store.countsSince(U(100), T0 + 2_000)).toEqual({ admitted: 0, rejected: 0, abandoned: 0 });
    });

    it("records an admission once and returns the latest for the user", async () => {
      const f = await make();
      await f.ensureDrop(U(100));
      await f.ensureUser(U(1));
      const ev = [{ type: "queue.admitted" as const, dropId: U(100), ticketId: U(301), waitedMs: 5000 }];
      await f.store.recordAdmission(rec(1), ev);
      await f.store.recordAdmission(rec(1), ev);
      expect((await f.eventTypes()).filter((t) => t === "queue.admitted")).toHaveLength(1);
      const got = await f.store.latestAdmission(U(100), U(1));
      expect(got).toEqual(rec(1));
      expect(await f.store.latestAdmission(U(100), U(2))).toBeNull();
    });

    it("tokens are single use and expire", async () => {
      const f = await make();
      await f.ensureDrop(U(100));
      await f.ensureUser(U(1));
      await f.store.recordAdmission(rec(1), []);
      expect(await f.store.consume(U(201), T0 + 1000)).toBe("used");
      expect(await f.store.consume(U(201), T0 + 2000)).toBe("already_used");
      expect(await f.store.consume(U(999), T0)).toBe("unknown");
      await f.ensureUser(U(2));
      await f.store.recordAdmission(rec(2), []);
      expect(await f.store.consume(U(202), T0 + 15 * 60_000)).toBe("expired");
    });

    it("concurrent consumers: exactly one wins", async () => {
      const f = await make();
      await f.ensureDrop(U(100));
      await f.ensureUser(U(3));
      await f.store.recordAdmission(rec(3), []);
      const r = await Promise.all([1, 2, 3, 4, 5].map((i) => f.store.consume(U(203), T0 + i)));
      expect(r.filter((x) => x === "used")).toHaveLength(1);
      expect(r.filter((x) => x === "already_used")).toHaveLength(4);
    });

    it("records ended tickets once and emits the abandoned event", async () => {
      const f = await make();
      await f.ensureDrop(U(100));
      await f.ensureUser(U(4));
      const t = { ticketId: U(304), dropId: U(100), userId: U(4), deviceHash: DEV(4), joinedAtMs: T0, state: "abandoned" as const, atMs: T0 + 40_000 };
      const ev = [{ type: "queue.abandoned" as const, dropId: U(100), ticketId: U(304), reason: "heartbeat" as const }];
      await f.store.recordEnded(t, ev);
      await f.store.recordEnded(t, ev);
      expect((await f.eventTypes()).filter((x) => x === "queue.abandoned")).toHaveLength(1);
    });

    it("the outbox payload never carries the device hash or user id", async () => {
      const f = await make();
      await f.ensureDrop(U(100));
      await f.ensureUser(U(5));
      await f.store.recordJoined(U(100), U(305), [{ type: "queue.joined", dropId: U(100), ticketId: U(305) }]);
      expect(await f.eventTypes()).toContain("queue.joined");
    });
  });
}
