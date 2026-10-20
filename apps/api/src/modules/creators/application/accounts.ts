import {
  canEarn,
  checkApplication,
  isReservedHandle,
  normalizeHandle,
  payoutEligible,
  type CreatorStatus,
  type IneligibleReason,
  type PayoutPref,
} from "../domain/bridge";
import type {
  Clock,
  CreatorAccount,
  CreatorFlagsPort,
  CreatorIdentityPort,
  CreatorKycVaultPort,
  CreatorStore,
  IdPort,
  TermsPort,
} from "../domain/ports";
import type { CreatorRuntimeOptions } from "./shared";

export interface ApplyInput {
  readonly handle: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly nationalId: string;
  readonly payoutIban: string | null;
  readonly payoutName: string | null;
  /** VERIFY BEFORE LAUNCH (VR-P3-03). */
  readonly taxId: string | null;
  readonly taxForm: string | null;
  readonly acceptTermsVersion: number;
}

export type ApplyResult =
  | { readonly kind: "applied"; readonly account: CreatorAccount }
  | { readonly kind: "already_applied"; readonly account: CreatorAccount }
  | { readonly kind: "ineligible"; readonly reason: IneligibleReason }
  | { readonly kind: "handle_taken" }
  | { readonly kind: "conflict" }
  | { readonly kind: "unavailable" };

export class ApplyAsCreator {
  constructor(
    private readonly store: CreatorStore,
    private readonly identity: CreatorIdentityPort,
    private readonly vault: CreatorKycVaultPort,
    private readonly terms: TermsPort,
    private readonly flags: CreatorFlagsPort,
    private readonly clock: Clock,
    private readonly ids: IdPort,
    private readonly opts: CreatorRuntimeOptions,
  ) {}

  async execute(userId: string, input: ApplyInput): Promise<ApplyResult> {
    if (!(await this.flags.programEnabled())) return { kind: "unavailable" };
    const existing = await this.store.getByUser(userId);
    if (existing !== null) return { kind: "already_applied", account: existing };

    const profile = await this.identity.profile(userId);
    const current = await this.terms.currentVersion();
    if (current === null) return { kind: "unavailable" };
    // A-7: the accepted text must be stored (insert-or-verify) so it can be shown back later.
    const texts = (await this.terms.texts?.(current)) ?? [];
    if (texts.length === 0) return { kind: "unavailable" };
    if ((await this.store.ensureTerms(current, texts)) !== "ok") return { kind: "unavailable" };
    const handle = normalizeHandle(input.handle);
    const reason = checkApplication(this.opts.config, {
      ageYears: profile?.ageYears ?? null,
      handle: input.handle,
      termsVersionAccepted: input.acceptTermsVersion === current ? current : null,
      sellerConflict: false,
    });
    if (reason !== null || handle === null) return { kind: "ineligible", reason: reason ?? "handle_invalid" };

    const nowMs = this.clock.nowMs();
    const sealed = await this.vault.seal({
      legalName: input.legalName,
      nationalId: input.nationalId,
      payoutIban: input.payoutIban,
      payoutName: input.payoutName,
      taxId: input.taxId,
      taxForm: input.taxForm,
    });
    const account: CreatorAccount = {
      id: this.ids.uuidV7(),
      userId,
      handle,
      displayName: input.displayName.trim(),
      status: "APPLIED",
      kycState: "SUBMITTED",
      termsVersion: current,
      termsAcceptedAtMs: nowMs,
      payoutPref: "credit",
      statusReason: null,
      appliedAtMs: nowMs,
      decidedAtMs: null,
    };
    const r = await this.store.createAccount(account, sealed, [{ type: "creator.applied", creatorId: account.id }]);
    switch (r.kind) {
      case "created":
        return { kind: "applied", account };
      case "handle_taken":
        return { kind: "handle_taken" };
      case "identity_in_use":
        return { kind: "conflict" };
      case "exists": {
        const again = await this.store.getByUser(userId);
        return again === null ? { kind: "conflict" } : { kind: "already_applied", account: again };
      }
    }
  }
}

export type DecideAction = "approve" | "reject" | "needs_info" | "suspend" | "reinstate";
export type DecideResult =
  | { readonly kind: "ok"; readonly account: CreatorAccount }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid_state"; readonly status: CreatorStatus }
  | { readonly kind: "ineligible"; readonly reason: IneligibleReason }
  /** A-10: approval records the review evidence (automated KYC and sanctions check reference). */
  | { readonly kind: "evidence_required" };

export class DecideCreator {
  constructor(
    private readonly store: CreatorStore,
    private readonly identity: CreatorIdentityPort,
    private readonly clock: Clock,
    private readonly opts: CreatorRuntimeOptions,
  ) {}

  async execute(input: { readonly creatorId: string; readonly action: DecideAction; readonly reason: string | null; readonly reviewerId: string }): Promise<DecideResult> {
    const a = await this.store.getById(input.creatorId);
    if (a === null) return { kind: "not_found" };
    const nowMs = this.clock.nowMs();
    const done = async (
      status: CreatorStatus,
      kycState: CreatorAccount["kycState"],
      event: Parameters<CreatorStore["decide"]>[0]["events"],
    ): Promise<DecideResult> => {
      const next = await this.store.decide({
        creatorId: a.id,
        status,
        kycState,
        reason: input.reason,
        reviewerId: input.reviewerId,
        nowMs,
        events: event,
      });
      if (next === null) return { kind: "not_found" };
      if (status === "SUSPENDED" || status === "REJECTED") await this.store.disableLinksOf(a.id, nowMs);
      return { kind: "ok", account: next };
    };

    switch (input.action) {
      case "approve":
      case "reinstate": {
        const from: CreatorStatus[] = input.action === "approve" ? ["APPLIED"] : ["SUSPENDED"];
        if (!from.includes(a.status)) return { kind: "invalid_state", status: a.status };
        if (input.action === "approve" && (input.reason === null || input.reason.trim() === "")) return { kind: "evidence_required" };
        const p = await this.identity.profile(a.userId);
        const reason = canEarn(this.opts.config, {
          status: "ACTIVE",
          kycState: "APPROVED",
          ageYears: p?.ageYears ?? null,
          termsAccepted: true,
        });
        if (reason !== null) return { kind: "ineligible", reason };
        return done("ACTIVE", "APPROVED", [{ type: "creator.approved", creatorId: a.id }]);
      }
      case "reject":
        if (a.status !== "APPLIED") return { kind: "invalid_state", status: a.status };
        return done("REJECTED", "REJECTED", [{ type: "creator.rejected", creatorId: a.id, reason: input.reason ?? "rejected" }]);
      case "needs_info":
        if (a.status !== "APPLIED") return { kind: "invalid_state", status: a.status };
        return done("APPLIED", "NEEDS_INFO", []);
      case "suspend":
        if (a.status !== "ACTIVE") return { kind: "invalid_state", status: a.status };
        return done("SUSPENDED", a.kycState, [{ type: "creator.suspended", creatorId: a.id, reason: input.reason ?? "suspended" }]);
    }
  }
}

export class SetPayoutPreference {
  constructor(
    private readonly store: CreatorStore,
    private readonly clock: Clock,
  ) {}
  async execute(userId: string, pref: PayoutPref): Promise<boolean> {
    const a = await this.store.getByUser(userId);
    if (a === null) return false;
    return this.store.setPayoutPref(a.id, pref, this.clock.nowMs());
  }
}

/** Facts for the earning and payout gates of one creator. */
export async function creatorFacts(
  identity: CreatorIdentityPort,
  a: CreatorAccount,
): Promise<{ readonly status: CreatorStatus; readonly kycState: CreatorAccount["kycState"]; readonly ageYears: number | null; readonly termsAccepted: boolean }> {
  const p = await identity.profile(a.userId);
  return { status: a.status, kycState: a.kycState, ageYears: p?.ageYears ?? null, termsAccepted: true };
}

export { isReservedHandle, payoutEligible };
