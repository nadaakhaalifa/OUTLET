import { createHash } from "node:crypto";
import { CatalogError } from "@outlet/catalog";
import type { SellerStore, StoreService } from "@outlet/catalog";
import type { Queryable } from "@outlet/db";
import type { Principal } from "@outlet/policy";
import type { SellerOnboardingService } from "@outlet/seller-accounts";
import type { AuditAppendPort } from "./ops-services.js";

export interface StoreModerationInput { readonly reasonCode: string; readonly note: string; readonly approvalRequestId: string }

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
  /** Idempotent effect of an APPROVED request: moves the seller and hides or restores its stores. Runs in its own transactions (other database roles). */
  apply(p: Principal, storeId: string, to: "SUSPENDED" | "ACTIVE", input: StoreModerationInput): Promise<StoreModerationResult>;
  /** The audit entry, written in the approval's claim transaction so it commits (or rolls back) with the claim. */
  record(p: Principal, tx: Queryable, r: StoreModerationResult): Promise<void>;
}

export interface StoreModerationDeps {
  readonly stores: Pick<StoreService, "getForAdmin" | "setModerationStatus">;
  readonly sellers: Pick<SellerOnboardingService, "suspendStore" | "reinstateStore">;
  readonly audit: AuditAppendPort;
}

/**
 * Suspension is two effects in two transactions (the seller and its KYC case as the seller.kyc worker job, the stores and the public read model in the
 * store context) and neither can share the approval's claim transaction (other database roles). So the controller applies the effects first, from a request
 * that admin-access.verifyApproved has proven approved and untampered, and only then claims it and writes the audit entry (`record`). Every effect is idempotent:
 * if the claim fails after the effects committed, the request stays APPROVED and POST approval-requests/{id}/execute converges instead of failing.
 * The seller is suspended first (nothing new can be activated), then every live store of that seller is hidden; stores that are not live (draft, in review,
 * closed) are skipped.
 */
export class StoreModeration implements StoreModerationPort {
  constructor(private readonly d: StoreModerationDeps) {}

  get(p: Principal, storeId: string): Promise<SellerStore> {
    return this.d.stores.getForAdmin(p, storeId);
  }

  async apply(p: Principal, storeId: string, to: "SUSPENDED" | "ACTIVE", input: StoreModerationInput): Promise<StoreModerationResult> {
    const before = await this.d.stores.getForAdmin(p, storeId);
    const reason = { reasonCode: input.reasonCode, note: input.note };
    const seller = to === "SUSPENDED" ? await this.d.sellers.suspendStore(p, storeId, reason) : await this.d.sellers.reinstateStore(p, storeId, reason);
    const changed: string[] = [];
    for (const id of seller.storeIds) {
      try {
        await this.d.stores.setModerationStatus(p, id, to);
        changed.push(id);
      } catch (e) {
        // A store that is not live (draft, in review, closed) has nothing to hide or restore; the requested store itself must succeed.
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
