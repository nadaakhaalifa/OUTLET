import type { PlusPlan } from "../../domain/bridge";
import { PLUS_FLAGS } from "../../domain/ports";
import { createPlusWorld, U } from "../../test/harness";
import { CancelPlus, SwitchPlan } from "../../application/manage";
import { Subscribe } from "../../application/subscribe";
import { HandleRecurringWebhook, RunRenewalSweep } from "../../application/sweeper";
import { GetMyPlus, PlusEntitlements, RecordBenefitUsed } from "../../application/member";
import { ListPlans, PublishPlanVersion } from "../../application/plans";
import {
  AcceptInvite,
  CreateFamily,
  FamilySeatEntitlements,
  GetFamily,
  GetStudentStatus,
  HandleStudentCallback,
  InviteMember,
  LeaveFamily,
  RemoveMember,
  RevokeInvite,
  RunFamilySweep,
  RunStudentSweep,
  StartStudentVerification,
  StudentEligibility,
  SubscribeByKind,
  TerminateFamilyForOwner,
  type FamilyDeps,
} from "../application";
import {
  FakeFamilyIdentity,
  FakeInviteDelivery,
  FakeStudentVerifier,
  InMemoryFamilyStore,
  InMemoryStudentStore,
  SequentialInviteTokens,
} from "../in-memory";

export { U };

/** Plus world plus family and student plans, fakes and every Phase 3 use case wired like the module does. */
export async function createFamilyWorld() {
  const w = createPlusWorld();
  const mk = (code: string, kind: "family" | "student", priceMinor: bigint, seatLimit: number | null): PlusPlan => ({
    id: w.ids.uuidV7(),
    code,
    kind,
    seatLimit,
    interval: "year",
    priceMinor,
    version: 1,
    active: true,
    trialDays: 0,
    effectiveFromMs: 0,
    notifiedAtMs: null,
  });
  const familyPlan = mk("plus_family", "family", 120_000n, 4);
  const studentPlan = mk("plus_student", "student", 60_000n, null);
  await w.store.savePlan(familyPlan, []);
  await w.store.savePlan(studentPlan, []);

  const familyStore = new InMemoryFamilyStore();
  const studentStore = new InMemoryStudentStore();
  const identity = new FakeFamilyIdentity("test-identity");
  const delivery = new FakeInviteDelivery();
  const tokens = new SequentialInviteTokens();
  const verifier = new FakeStudentVerifier();
  const eligibility = new StudentEligibility(studentStore, w.notices, w.clock);
  const d = { ...w.d, students: eligibility };
  const fd: FamilyDeps = { plus: d, family: familyStore, students: studentStore, identity, delivery, tokens, verifier };
  const seats = new FamilySeatEntitlements(fd);
  const subscribe = new Subscribe(d);

  const phoneOf = (n: number): string => `+2010000${String(n).padStart(5, "0")}`;

  const uc = {
    plans: new ListPlans(w.store, w.clock),
    subscribe: new SubscribeByKind(fd, subscribe, eligibility),
    rawSubscribe: subscribe,
    createFamily: new CreateFamily(fd, subscribe),
    getFamily: new GetFamily(fd),
    invite: new InviteMember(fd),
    revoke: new RevokeInvite(fd),
    accept: new AcceptInvite(fd),
    remove: new RemoveMember(fd),
    leave: new LeaveFamily(fd),
    familySweep: new RunFamilySweep(fd),
    terminate: new TerminateFamilyForOwner(fd),
    startStudent: new StartStudentVerification(fd),
    studentCallback: new HandleStudentCallback(fd),
    studentStatus: new GetStudentStatus(fd),
    studentSweep: new RunStudentSweep(fd),
    cancel: new CancelPlus(d),
    switchPlan: new SwitchPlan(d),
    sweep: new RunRenewalSweep(d),
    webhook: new HandleRecurringWebhook(d),
    entitlements: new PlusEntitlements(w.store, w.clock, seats),
    mine: new GetMyPlus(w.store, w.clock, seats),
    recordBenefit: new RecordBenefitUsed(w.store, w.clock, w.ids, seats),
    publish: new PublishPlanVersion(w.store, w.clock, w.ids, w.approvals, w.notices),
  };

  return {
    ...w,
    d,
    fd,
    uc,
    familyPlan,
    studentPlan,
    familyStore,
    studentStore,
    identity,
    delivery,
    verifier,
    seats,
    phoneOf,
    flags: w.flags,
    /** A shopper with a verified phone, card and age. */
    person(n: number, o: { age?: number; otp?: boolean; fingerprint?: string } = {}) {
      const m = w.member(n, { age: o.age ?? 30, ...(o.fingerprint !== undefined ? { fingerprint: o.fingerprint } : {}) });
      const hash = identity.register(m.userId, phoneOf(n), o.otp ?? true);
      w.persons.set(m.userId, hash);
      return { ...m, phone: phoneOf(n) };
    },
    /** Subscribes `n` to the family plan and returns the owner person. */
    async owner(n: number) {
      const p = this.person(n);
      const r = await uc.createFamily.execute({
        userId: p.userId,
        tokenRef: p.tokenRef,
        deviceId: p.deviceId,
        method: "card",
        requestKey: `fam-${n}`,
      });
      if (r.kind !== "subscribed" && r.kind !== "existing") throw new Error(`owner setup failed: ${r.kind}`);
      return p;
    },
    /** Invites `phone` and returns the delivered token. */
    async inviteAndToken(ownerId: string, phone: string, nickname: string | null = null) {
      const r = await uc.invite.execute({ ownerUserId: ownerId, phoneE164: phone, nickname });
      if (r.kind !== "invited") throw new Error(`invite failed: ${r.kind}${"reason" in r ? ` ${r.reason}` : ""}`);
      const last = delivery.last();
      if (last === undefined) throw new Error("nothing delivered");
      return { token: last.token, memberId: r.memberId, inviteId: r.inviteId };
    },
    FLAGS: PLUS_FLAGS,
  };
}

export type FamilyWorld = Awaited<ReturnType<typeof createFamilyWorld>>;
