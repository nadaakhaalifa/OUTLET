import { describe, expect, it } from "vitest";
import { FakeSession } from "../session/fake";
import { createAdminApi } from "./client";
import { NetworkError, type Transport, type TransportRequest, type TransportResponse } from "./transport";

const U = "11111111-1111-4111-8111-111111111111";
const session = (): FakeSession => new FakeSession({ initial: { accessToken: "tok", refreshToken: "r", accessExpiresAtMs: Date.now() + 1e6 } });

function transport(responses: TransportResponse[] | (() => never)): { t: Transport; calls: TransportRequest[] } {
  const calls: TransportRequest[] = [];
  const queue = Array.isArray(responses) ? [...responses] : null;
  return {
    calls,
    t: {
      async send(req) {
        calls.push(req);
        if (queue === null) (responses as () => never)();
        const next = queue?.shift();
        if (next === undefined) throw new Error("no response");
        return next;
      },
    },
  };
}

const flag = { key: "kill.drops", kind: "kill_switch", description: "d", enabled: true, is_default: false };

describe("admin api client", () => {
  it("validates responses at the boundary and returns the server clock", async () => {
    const { t, calls } = transport([{ status: 200, headers: { date: "Sun, 11 Oct 2026 10:00:00 GMT" }, json: { items: [flag] } }]);
    const api = createAdminApi({ transport: t, session: session(), newIdempotencyKey: () => "k" });
    const r = await api.killSwitches();
    expect(r.ok && r.value.data.items[0]?.key).toBe("kill.drops");
    expect(r.ok && r.value.serverNowMs).toBe(Date.parse("2026-10-11T10:00:00Z"));
    expect(calls[0]?.headers?.authorization).toBe("Bearer tok");
    expect(calls[0]?.headers?.["idempotency-key"]).toBeUndefined();
  });
  it("turns an unexpected shape into a contract error, never partial data", async () => {
    const { t } = transport([{ status: 200, headers: {}, json: { items: [{ key: 1 }] } }]);
    const r = await createAdminApi({ transport: t, session: session(), newIdempotencyKey: () => "k" }).killSwitches();
    expect(r).toEqual({ ok: false, error: { kind: "contract", status: 200 } });
  });
  it("sends an idempotency key on writes and the enumerated reason code", async () => {
    const { t, calls } = transport([{ status: 200, headers: {}, json: { ...flag, enabled: false, previous_enabled: true } }]);
    const r = await createAdminApi({ transport: t, session: session(), newIdempotencyKey: () => "key-1" }).setFlag("kill.drops", false, "incident_response");
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/v1/admin/flags/kill.drops", body: { enabled: false, reason_code: "incident_response" } });
    expect(calls[0]?.headers?.["idempotency-key"]).toBe("key-1");
  });
  it("maps 403, 404, 409 and request ids", async () => {
    const { t } = transport([
      { status: 403, headers: {}, json: { code: "missing_role", request_id: "req-9" } },
      { status: 404, headers: {} },
      { status: 409, headers: {}, json: { code: "approval_expired" } },
    ]);
    const api = createAdminApi({ transport: t, session: session(), newIdempotencyKey: () => "k" });
    expect(await api.approvals()).toEqual({ ok: false, error: { kind: "forbidden", status: 403, code: "missing_role", requestId: "req-9" } });
    expect(await api.approvals()).toMatchObject({ error: { kind: "not_found" } });
    expect(await api.approve(U)).toMatchObject({ error: { kind: "conflict", code: "approval_expired" } });
  });
  it("refreshes once on 401 and reuses the same idempotency key", async () => {
    const s = session();
    const { t, calls } = transport([
      { status: 401, headers: {} },
      { status: 200, headers: {}, json: { ...flag, enabled: true, previous_enabled: false } },
    ]);
    const r = await createAdminApi({ transport: t, session: s, newIdempotencyKey: () => "once" }).setFlag("kill.drops", true, "kyc_review");
    expect(r.ok).toBe(true);
    expect(s.refreshCalls).toBe(1);
    expect(calls.map((c) => c.headers?.["idempotency-key"])).toEqual(["once", "once"]);
  });
  it("reports offline and signed-out without calling the network", async () => {
    const off = createAdminApi({ transport: transport(() => { throw new NetworkError("down"); }).t, session: session(), newIdempotencyKey: () => "k" });
    expect(await off.approvals()).toEqual({ ok: false, error: { kind: "offline" } });
    const { t, calls } = transport([]);
    const out = createAdminApi({ transport: t, session: new FakeSession(), newIdempotencyKey: () => "k" });
    expect(await out.approvals()).toMatchObject({ error: { kind: "unauthorized" } });
    expect(calls).toHaveLength(0);
  });
});
