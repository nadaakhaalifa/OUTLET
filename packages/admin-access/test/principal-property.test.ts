import { uuidv7 } from "@outlet/ids";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ADMIN_ROLES } from "@outlet/policy";
import { T0, admin, makeEnv } from "./helpers.js";

type Op =
  | { t: "grant"; role: string; days: number }
  | { t: "revoke"; role: string }
  | { t: "elevate"; role: string; mins: number }
  | { t: "advance"; ms: number };

const role = fc.constantFrom(...ADMIN_ROLES);
const op: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ t: fc.constant("grant" as const), role, days: fc.integer({ min: 1, max: 5 }) }),
  fc.record({ t: fc.constant("revoke" as const), role }),
  fc.record({ t: fc.constant("elevate" as const), role, mins: fc.integer({ min: 1, max: 60 }) }),
  fc.record({ t: fc.constant("advance" as const), ms: fc.oneof(fc.integer({ min: 1, max: 3_600_000 }), fc.integer({ min: 3_600_000, max: 6 * 86_400_000 })) }),
);

describe("property: buildPrincipal never exposes a role without a live grant or elevation", () => {
  it("holds over random grant / revoke / elevate / expire sequences and equals the model", async () => {
    const { svc, seedGrant, setNow, advance, close } = await makeEnv();
    const [x, y, z] = [uuidv7(), uuidv7(), uuidv7()];
    for (const u of [x, y, z]) await seedGrant(u, "security");
    const px = await svc.buildPrincipal("EG", x);
    const py = await svc.buildPrincipal("EG", y);
    const pz = await svc.buildPrincipal("EG", z);

    await fc.assert(
      fc.asyncProperty(fc.array(op, { maxLength: 8 }), async (ops) => {
        setNow(new Date(T0));
        const target = uuidv7();
        const tp = admin(target, []);
        const grants: { id: string; role: string; exp: number; revoked: boolean }[] = [];
        const elevs: { role: string; end: number }[] = [];
        let t = T0.getTime();
        for (const o of ops) {
          if (o.t === "advance") { advance(o.ms); t += o.ms; }
          else if (o.t === "grant") {
            const r = await svc.grantRole(px, { staffId: target }, o.role, { reason: "p", ttlDays: o.days });
            await svc.approve(py, r.id); await svc.approve(pz, r.id);
            const res = await svc.applyRoleGrant(px, r.id);
            if (!res.executed) throw new Error("expected execution");
            const exp = t + o.days * 86_400_000;
            const live = grants.find((g) => g.role === o.role && !g.revoked && g.exp > t);
            if (live) live.exp = Math.max(live.exp, exp); else grants.push({ id: res.result.assignmentId, role: o.role, exp, revoked: false });
          } else if (o.t === "revoke") {
            const live = grants.find((g) => g.role === o.role && !g.revoked && g.exp > t);
            if (live) { await svc.revokeRole(px, live.id, { reason: "p" }); live.revoked = true; }
          } else {
            const e = await svc.requestElevation(tp, o.role, { reason: "p", ttlMinutes: o.mins });
            if (o.role === "super_admin") {
              const req = e.approvalRequestId ?? "";
              await svc.approve(py, req); await svc.approve(pz, req);
              await svc.activateElevation(px, req);
            } else await svc.approveElevation(py, e.id);
            elevs.push({ role: o.role, end: t + o.mins * 60_000 });
          }
          const p = await svc.buildPrincipal("EG", target);
          const expected = new Set<string>([
            ...grants.filter((g) => !g.revoked && g.exp > t).map((g) => g.role),
            ...elevs.filter((e) => e.end > t).map((e) => e.role),
          ]);
          // safety: no role without a live source; completeness: nothing live is missing
          expect([...p.roles].sort()).toEqual([...expected].sort());
          expect(p.breakGlass === true).toBe(elevs.some((e) => e.role === "super_admin" && e.end > t));
        }
      }),
      { numRuns: 20 },
    );
    await close();
  });
});
