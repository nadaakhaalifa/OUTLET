# @outlet/admin-access

Admin role grants, JIT elevation, dual approval and PII-view reason codes.

- Role grants and `data.export`/`plan.price.change` always need 2 distinct approvers holding `role.grant` (requester excluded).
- JIT elevation: single approver, except `super_admin` (break-glass, ADM-T06): `requestElevation` files an
  `elevation.approve` request (2 approvals); `activateElevation(actor, approvalRequestId)` activates it once and emits
  `admin.break_glass_activated` (actor, approvers, reason, ttlMinutes).

## buildPrincipal(marketId, adminUserId, now?)

Returns the `Principal` with standing grants plus active elevations at `now` (default: injected clock).
`breakGlass: true` is set only while an approved `super_admin` elevation is active.

```ts
const access = createAdminAccess({ db, audit, clock: () => new Date(), thresholdMinor: 1_000_000n });
const admin = await access.buildPrincipal("EG", staffId);               // roles live right now
const past = await access.buildPrincipal("EG", staffId, new Date(ts)); // roles as of ts
const e = await access.requestElevation(admin, "super_admin", { reason: "sev1", ttlMinutes: 20 });
await access.approve(approverA, e.approvalRequestId!);
await access.approve(approverB, e.approvalRequestId!);
await access.activateElevation(approverC, e.approvalRequestId!);       // now buildPrincipal(...).breakGlass === true
await access.recordPiiView(admin, { action: "user.read", targetType: "user", targetId: id }, "support_ticket");
```
