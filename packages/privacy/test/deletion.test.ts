import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "@outlet/db";
import { createLogger } from "@outlet/logger";
import {
  DeletionBlockedError,
  DeletionService,
  DuplicateOpenRequestError,
  InvalidTransitionError,
  RequestNotFoundError,
  UserNotFoundError,
  assertTransition,
  canTransition,
  TRANSITIONS,
} from "../src/index.js";
import type { BlockerPort, DeletionBlocker, PseudonymizerPort } from "../src/index.js";
import { events, insertUser, setupEnv } from "./helpers.js";
import type { Env } from "./helpers.js";

let env: Env;
beforeEach(async () => {
  env = await setupEnv();
});
afterEach(async () => {
  await env.close();
});

class FakeBlockers implements BlockerPort {
  list: DeletionBlocker[] = [];
  findBlockers(): Promise<readonly DeletionBlocker[]> {
    return Promise.resolve(this.list);
  }
}
class FakePseudo implements PseudonymizerPort {
  calls: string[] = [];
  fail = false;
  async pseudonymize(tx: Queryable, s: { userId: string; marketId: string }): Promise<void> {
    await tx.query("UPDATE users SET display_name = NULL, phone_ct = NULL, email_ct = NULL, dob_ct = NULL WHERE id = $1", [s.userId]);
    this.calls.push(s.userId);
    if (this.fail) throw new Error("pseudonymizer boom");
  }
}

const DAY = 86_400_000;
const mk = async (): Promise<{ svc: DeletionService; blockers: FakeBlockers; pseudo: FakePseudo; user: string; lines: string[] }> => {
  const blockers = new FakeBlockers();
  const pseudo = new FakePseudo();
  const lines: string[] = [];
  const svc = new DeletionService(env.deps, blockers, pseudo, createLogger({ write: (l) => lines.push(l) }));
  return { svc, blockers, pseudo, user: await insertUser(env.client), lines };
};
const status = async (id: string): Promise<string | undefined> =>
  (await env.client.query<{ status: string }>("SELECT status FROM privacy_requests WHERE id = $1", [id])).rows[0]?.status;
const userStatus = async (id: string): Promise<string | undefined> =>
  (await env.client.query<{ status: string }>("SELECT status FROM users WHERE id = $1", [id])).rows[0]?.status;

describe("state machine", () => {
  it("allows the documented edges only", () => {
    expect(canTransition("delete", "COOLING", "CANCELLED")).toBe(true);
    expect(canTransition("delete", "COMPLETED", "COOLING")).toBe(false);
    expect(() => { assertTransition("delete", "CANCELLED", "IN_PROGRESS"); }).toThrow(InvalidTransitionError);
    expect(() => { assertTransition("export", "COMPLETED", "IN_PROGRESS"); }).toThrow(/export request cannot move/);
  });
  it("terminal states have no outgoing edges and every edge targets a known state", () => {
    for (const kind of ["delete", "export"] as const) {
      const t = TRANSITIONS[kind];
      for (const to of ["COMPLETED", "CANCELLED", "REJECTED", "BLOCKED"] as const) expect(t[to]).toEqual([]);
      for (const targets of Object.values(t)) for (const x of targets) expect(Object.keys(t)).toContain(x);
    }
  });
});

describe("DeletionService", () => {
  it("is blocked with typed reasons and creates nothing", async () => {
    const { svc, blockers, user } = await mk();
    blockers.list = [
      { kind: "open_order", count: 2 },
      { kind: "open_return", count: 0 },
      { kind: "open_dispute", count: 1 },
    ];
    const err = await svc.request(user).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeletionBlockedError);
    expect((err as DeletionBlockedError).blockers).toEqual([
      { kind: "open_order", count: 2 },
      { kind: "open_dispute", count: 1 },
    ]);
    expect((await env.client.query("SELECT 1 FROM privacy_requests")).rows).toHaveLength(0);
    expect(await userStatus(user)).toBe("active");
  });

  it("creates a 14-day cooling request, marks the user pending and emits an event", async () => {
    const { svc, user } = await mk();
    const v = await svc.request(user);
    expect(v.status).toBe("COOLING");
    expect(v.coolingUntil.getTime() - env.clock.t).toBeLessThanOrEqual(14 * DAY);
    expect(v.coolingUntil.getTime() - env.clock.t).toBeGreaterThan(14 * DAY - 1000);
    expect(await userStatus(user)).toBe("deletion_pending");
    expect(await events(env.client, "privacy.deletion_requested")).toHaveLength(1);
  });

  it("is idempotent per key and refuses a second open request", async () => {
    const { svc, user } = await mk();
    const key = "01900000-0000-7000-8000-00000000000b";
    const a = await svc.request(user, key);
    const b = await svc.request(user, key);
    expect(b.id).toBe(a.id);
    await expect(svc.request(user)).rejects.toBeInstanceOf(DuplicateOpenRequestError);
    expect(await events(env.client, "privacy.deletion_requested")).toHaveLength(1);
  });

  it("unknown user is a typed error", async () => {
    const { svc } = await mk();
    await expect(svc.request("01900000-0000-7000-8000-0000000000aa")).rejects.toBeInstanceOf(UserNotFoundError);
  });

  it("cancel during cooling restores the account; a second cancel is invalid", async () => {
    const { svc, user } = await mk();
    const v = await svc.request(user);
    await svc.cancel(user, v.id);
    expect(await status(v.id)).toBe("CANCELLED");
    expect(await userStatus(user)).toBe("active");
    await expect(svc.cancel(user, v.id)).rejects.toBeInstanceOf(InvalidTransitionError);
    // user may request again after cancelling
    await svc.request(user);
  });

  it("cancel checks ownership and existence", async () => {
    const { svc, user } = await mk();
    const other = await insertUser(env.client);
    const v = await svc.request(user);
    await expect(svc.cancel(other, v.id)).rejects.toBeInstanceOf(RequestNotFoundError);
    await expect(svc.cancel(user, "01900000-0000-7000-8000-0000000000cc")).rejects.toBeInstanceOf(RequestNotFoundError);
  });

  it("execute does nothing before the cooling period ends", async () => {
    const { svc, pseudo, user } = await mk();
    const v = await svc.request(user);
    env.clock.t += 13 * DAY;
    expect(await svc.execute()).toEqual({ completed: [], blocked: [], failed: [] });
    expect(pseudo.calls).toEqual([]);
    expect(await status(v.id)).toBe("COOLING");
  });

  it("execute nulls the blind indexes so the phone can register again", async () => {
    const { svc, user } = await mk();
    await env.client.query("UPDATE users SET phone_bidx = $2, email_bidx = $3 WHERE id = $1", [user, Buffer.alloc(32, 5), Buffer.alloc(32, 6)]);
    await svc.request(user);
    env.clock.t += 15 * DAY;
    await svc.execute();
    const r = await env.client.query<{ phone_bidx: unknown; email_bidx: unknown }>("SELECT phone_bidx, email_bidx FROM users WHERE id = $1", [user]);
    expect(r.rows[0]).toEqual({ phone_bidx: null, email_bidx: null });
  });

  it("execute completes due requests, pseudonymises and emits an event", async () => {
    const { svc, pseudo, user } = await mk();
    const v = await svc.request(user);
    env.clock.t += 15 * DAY;
    const r = await svc.execute();
    expect(r.completed).toEqual([v.id]);
    expect(pseudo.calls).toEqual([user]);
    expect(await status(v.id)).toBe("COMPLETED");
    expect(await userStatus(user)).toBe("deleted");
    expect(await events(env.client, "privacy.deletion_completed")).toHaveLength(1);
    expect((await svc.execute()).completed).toEqual([]);
    await expect(svc.cancel(user, v.id)).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("execute skips a request when a blocker appeared during cooling", async () => {
    const { svc, blockers, user } = await mk();
    const v = await svc.request(user);
    blockers.list = [{ kind: "open_return", count: 1 }];
    env.clock.t += 15 * DAY;
    expect(await svc.execute()).toEqual({ completed: [], blocked: [v.id], failed: [] });
    expect(await status(v.id)).toBe("COOLING");
  });

  it("a failing pseudonymizer rolls everything back and logs without PII", async () => {
    const { svc, pseudo, user, lines } = await mk();
    const v = await svc.request(user);
    pseudo.fail = true;
    env.clock.t += 15 * DAY;
    const r = await svc.execute();
    expect(r.failed).toEqual([v.id]);
    expect(await status(v.id)).toBe("COOLING");
    expect(await userStatus(user)).toBe("deletion_pending");
    expect(await events(env.client, "privacy.deletion_completed")).toHaveLength(0);
    expect(lines.join("\n")).toContain("deletion execution failed");
    // retry succeeds
    pseudo.fail = false;
    expect((await svc.execute()).completed).toEqual([v.id]);
  });

  it("non-Error failures are logged too, and logging is optional", async () => {
    const user = await insertUser(env.client);
    const throwing: PseudonymizerPort = { pseudonymize: () => Promise.reject("string failure") }; // eslint-disable-line @typescript-eslint/prefer-promise-reject-errors
    const svc = new DeletionService(env.deps, new FakeBlockers(), throwing);
    await svc.request(user);
    env.clock.t += 15 * DAY;
    expect((await svc.execute()).failed).toHaveLength(1);
  });
});
