import { describe, expect, it } from "vitest";
import type { BrandReviewOverlay } from "../domain";

const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const ADMIN = "00000000-0000-4000-8000-0000000000c3";
const STORE = "00000000-0000-4000-8000-0000000000d4";

/** Behaviour every BrandReviewOverlay must have, run against the in-memory and the Postgres adapter. */
export function describeOverlayContract(name: string, make: () => Promise<BrandReviewOverlay>): void {
  describe(`brand review overlay contract: ${name}`, () => {
    it("is empty for an unknown application", async () => {
      const o = await make();
      expect(await o.getCosign(A)).toBeNull();
      expect(await o.getFailure(A)).toBeNull();
      expect(await o.conflictingStoreId(A)).toBeNull();
      expect(await o.listFailures(10)).toEqual([]);
    });

    it("stores, replaces and clears the first approver", async () => {
      const o = await make();
      await o.setCosign(A, { firstApproverId: ADMIN, requestedAtMs: 1_700_000_000_000 });
      expect(await o.getCosign(A)).toEqual({ firstApproverId: ADMIN, requestedAtMs: 1_700_000_000_000 });
      await o.setCosign(A, { firstApproverId: B, requestedAtMs: 1_700_000_001_000 });
      expect(await o.getCosign(A)).toEqual({ firstApproverId: B, requestedAtMs: 1_700_000_001_000 });
      await o.clearCosign(A);
      expect(await o.getCosign(A)).toBeNull();
      await o.clearCosign(A); // idempotent
    });

    it("parks and unparks without touching the cosign state", async () => {
      const o = await make();
      await o.setCosign(A, { firstApproverId: ADMIN, requestedAtMs: 5_000 });
      await o.setFailure(A, "provisioning_error");
      expect(await o.getFailure(A)).toBe("provisioning_error");
      expect(await o.getCosign(A)).toEqual({ firstApproverId: ADMIN, requestedAtMs: 5_000 });
      await o.setFailure(A, "store_name_conflict");
      expect(await o.getFailure(A)).toBe("store_name_conflict");
      await o.clearFailure(A);
      expect(await o.getFailure(A)).toBeNull();
      expect(await o.getCosign(A)).toEqual({ firstApproverId: ADMIN, requestedAtMs: 5_000 });
    });

    it("lists parked applications oldest failure first and honours the limit", async () => {
      const o = await make();
      await o.setFailure(B, "provisioning_error");
      await new Promise((r) => setTimeout(r, 5));
      await o.setFailure(A, "provisioning_error");
      expect(await o.listFailures(10)).toEqual([B, A]);
      expect(await o.listFailures(1)).toEqual([B]);
      await o.setFailure(B, "store_name_conflict"); // a re-park keeps its place in the queue
      expect(await o.listFailures(10)).toEqual([B, A]);
      await o.clearFailure(B);
      expect(await o.listFailures(10)).toEqual([A]);
    });

    it("records the conflicting store and drops it when the failure clears", async () => {
      const o = await make();
      await o.recordConflict(A, STORE);
      await o.setFailure(A, "store_name_conflict");
      expect(await o.conflictingStoreId(A)).toBe(STORE);
      await o.setFailure(A, "store_name_conflict");
      expect(await o.conflictingStoreId(A)).toBe(STORE);
      await o.clearFailure(A);
      expect(await o.conflictingStoreId(A)).toBeNull();
    });

    it("recordRetry on an application with no row is a no-op", async () => {
      const o = await make();
      await o.recordRetry(A);
      expect(await o.getFailure(A)).toBeNull();
    });
  });
}
