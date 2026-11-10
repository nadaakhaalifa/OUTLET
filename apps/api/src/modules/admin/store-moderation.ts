import { createHash } from "node:crypto";
import { CatalogError } from "@outlet/catalog";
import type { SellerStore, StoreService } from "@outlet/catalog";
import type { Queryable } from "@outlet/db";
import type { Principal } from "@outlet/policy";
import type { SellerOnboardingService } from "@outlet/seller-accounts";
import { ProblemError } from "../../platform/problem.js";
import type { AuditAppendPort } from "./ports.js";

export interface StoreModerationInput {
  readonly reasonCode: string;
  readonly note: string;
  readonly approvalRequestId: string;
  /** The exact stores the approvers saw (pinned at filing, hash-protected); apply never touches another store. */
  readonly storeIds: readonly string[];
}

const FROM: Readonly<Record<"SUSPENDED" | "ACTIVE", readonly string[]>> = { SUSPENDED: ["ACTIVE", "VACATION"], ACTIVE: ["SUSPENDED"] };

/** What an applied moderation changed (input of the audit entry that commits with the approval claim). */
export interface StoreModerationResult {
  readonly store: SellerStore;
  readonly to: "SUSPENDED" | "ACTIVE";
  readonly beforeStatus: string;
  readonly sellerId: string;
  readonly changedStoreIds: readonly string[];
  readonly input: StoreModerationInput;
}

export interface StoreModerationPort {
  /** The store in any status (ops / trust_safety read); NotFound when it is not in the market. */
  get(p: Principal, storeId: string): Promise<SellerStore>;
  /** The store set a request files against: suspend = every live store of the seller (ACTIVE or VACATION), reinstate = only the target store. */
  targets(p: Principal, storeId: string, to: "SUSPENDED" | "ACTIVE"): Promise<readonly string[]>;
  /** Idempotent effect of an APPROVED request: moves the seller and hides or restores its stores. Runs in its own transactions (other database roles). */
  apply(p: Principal, storeId: string, to: "SUSPENDED" | "ACTIVE", input: StoreModerationInput): Promise<StoreModerationResult>;
  /** The audit entry, written in the approval's claim transaction so it commits (or rolls back) with the claim. */
  record(p: Principal, tx: Queryable, r: StoreModerationResult): Promise<void>;
}

export interface StoreModerationDeps {
  readonly stores: Pick<StoreService, "getForAdmin" | "setModerationStatus">;
  readonly sellers: Pick<SellerOnboardingService, "suspendStore" | "reinstateStore" | "storeSet">;
  readonly audit: AuditAppendPort;
}

/**
 * Suspension is two effects in two transactions (the seller and its KYC case as the seller.kyc worker job, the stores and the public read model in the
 * store context) and neither can share the approval's claim transaction (other database roles). So the controller applies the effects first, from a request
 * that admin-access.verifyApproved has proven approved and untampered, and only then claims it and writes the audit entry (`record`). Every effect is idempotent:
 * if the claim fails after the effects committed, the request stays APPROVED and POST approval-requests/{id}/execute converges instead of failing.
 * The seller is suspended first (nothing new can be activated), then only the stores named in the approved payload are hidden (the set the approvers saw);
 * stores that are not live (draft, in review, closed) are skipped. Reinstating touches only the target store and moves the seller back to APPROVED only when
 * none of its other stores is still SUSPENDED. The stale-state check runs before any write, so a store that changed between filing and execution is a 409 with nothing changed.
 */
export class StoreModeration implements StoreModerationPort {
  constructor(private readonly d: StoreModerationDeps) {}

  get(p: Principal, storeId: string): Promise<SellerStore> {
    return this.d.stores.getForAdmin(p, storeId);
  }

  async targets(p: Principal, storeId: string, to: "SUSPENDED" | "ACTIVE"): Promise<readonly string[]> {
    if (to === "ACTIVE") return [storeId];
    const set = await this.d.sellers.storeSet(p, storeId, "store.suspend");
    return set.stores.filter((s) => FROM.SUSPENDED.includes(s.status)).map((s) => s.id);
  }

  async apply(p: Principal, storeId: string, to: "SUSPENDED" | "ACTIVE", input: StoreModerationInput): Promise<StoreModerationResult> {
    const before = await this.d.stores.getForAdmin(p, storeId);
    // Before any write: a store that is neither in the allowed source state nor already at the target cannot be moved; nothing has changed and the request stays APPROVED.
    if (before.status !== to && !FROM[to].includes(before.status)) throw new ProblemError(409, "invalid-transition", `The store is ${before.status}`);
    if (!input.storeIds.includes(storeId) || (to === "ACTIVE" && input.storeIds.length !== 1)) throw new ProblemError(422, "invalid-approval-payload", "The approved store set does not match the request");
    const reason = { reasonCode: input.reasonCode, note: input.note };
    const seller = to === "SUSPENDED" ? await this.d.sellers.suspendStore(p, storeId, reason) : await this.d.sellers.reinstateStore(p, storeId, reason);
    const changed: string[] = [];
    for (const id of input.storeIds) {
      try {
        await this.d.stores.setModerationStatus(p, id, to);
        changed.push(id);
      } catch (e) {
        // A store of the approved set that is no longer live (closed meanwhile) has nothing to hide; the requested store itself must succeed.
        if (!(e instanceof CatalogError && e.code === "conflict" && id !== storeId)) throw e;
      }
    }
    return { store: await this.d.stores.getForAdmin(p, storeId), to, beforeStatus: before.status, sellerId: seller.sellerId, changedStoreIds: changed, input };
  }

  async record(p: Principal, tx: Queryable, r: StoreModerationResult): Promise<void> {
    await this.d.audit.appendIn(tx, {
      marketId: p.marketId, actorType: "staff", actorId: p.userId ?? "", action: r.to === "SUSPENDED" ? "store.suspended" : "store.reinstated", targetType: "store", targetId: r.store.id,
      diff: {
        before: { status: r.beforeStatus },
        after: {
          status: r.store.status, reasonCode: r.input.reasonCode, sellerId: r.sellerId, storeIds: r.changedStoreIds, approvalRequestId: r.input.approvalRequestId,
          noteHash: createHash("sha256").update(r.input.note).digest("hex"),
        },
      },
      ipHash: null, deviceId: null, requestId: null,
    });
  }
}
