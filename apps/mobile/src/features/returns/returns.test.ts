import { describe, expect, it } from "vitest";
import {
  EMPTY_DRAFT, FIXTURE_CANDIDATE, MAX_PHOTOS, addPhoto, buildReturnRequest, flowBlockers, photosRequired, removePhoto, resolutionOptions, setReason, windowFor,
  type ReturnEligibility,
} from "./model";

const e: ReturnEligibility = FIXTURE_CANDIDATE.eligibility; // delivered 2026-10-01T12:00Z, 14 / 30 days
const DAY = 86_400_000;
const delivered = Date.parse(e.deliveredAt);

describe("window counts from delivered_at", () => {
  it("uses 14 days for change of mind and 30 for defects", () => {
    expect(windowFor("changed_mind", e, delivered).days).toBe(14);
    expect(windowFor("defective", e, delivered).days).toBe(30);
  });
  it("day 15 is closed for change of mind, day 29 is open for defects", () => {
    expect(windowFor("changed_mind", e, delivered + 15 * DAY).open).toBe(false);
    expect(windowFor("defective", e, delivered + 29 * DAY).open).toBe(true);
  });
  it("reports whole days left", () => {
    expect(windowFor("changed_mind", e, delivered + 4 * DAY + 1000).daysLeft).toBe(9);
  });
});

describe("photos", () => {
  it("are required for defective and not-as-described only", () => {
    expect(photosRequired("defective")).toBe(true);
    expect(photosRequired("not_as_described")).toBe(true);
    expect(photosRequired("changed_mind")).toBe(false);
  });
  it("block submission until one is attached, with a cap and no duplicates", () => {
    const d = setReason(EMPTY_DRAFT, "defective", e);
    expect(flowBlockers(d, e, delivered + DAY)).toContain("photos");
    const withPhoto = addPhoto(d, { uri: "a" });
    expect(flowBlockers(withPhoto, e, delivered + DAY)).not.toContain("photos");
    expect(addPhoto(withPhoto, { uri: "a" }).photos).toHaveLength(1);
    let full = EMPTY_DRAFT;
    for (let i = 0; i < MAX_PHOTOS + 2; i += 1) full = addPhoto(full, { uri: `p${i}` });
    expect(full.photos).toHaveLength(MAX_PHOTOS);
    expect(removePhoto(withPhoto, "a").photos).toHaveLength(0);
  });
});

describe("exchange first", () => {
  it("offers exchange before refund for size reasons when a swap is in stock", () => {
    expect(resolutionOptions("too_small", e)).toEqual(["exchange", "refund"]);
    expect(setReason(EMPTY_DRAFT, "too_large", e).resolution).toBe("exchange");
  });
  it("offers refund only otherwise", () => {
    expect(resolutionOptions("too_small", { ...e, exchangeInStock: false })).toEqual(["refund"]);
    expect(resolutionOptions("changed_mind", e)).toEqual(["refund"]);
    expect(resolutionOptions(null, e)).toEqual([]);
  });
});

describe("submission", () => {
  it("is blocked for an ineligible item, a missing reason or a closed window", () => {
    expect(flowBlockers(EMPTY_DRAFT, { ...e, eligible: false }, delivered)).toEqual(["notEligible", "reason"]);
    const d = setReason(EMPTY_DRAFT, "changed_mind", e);
    const one = { ...e, allowedRefundTargets: ["original" as const] };
    expect(flowBlockers(d, one, delivered + 15 * DAY)).toEqual(["window"]);
    expect(flowBlockers(d, one, delivered + 2 * DAY)).toEqual([]);
  });
  it("requires choosing a refund target when several are allowed", () => {
    const d = setReason(EMPTY_DRAFT, "changed_mind", e);
    expect(flowBlockers(d, e, delivered)).toEqual(["refundTarget"]);
    expect(flowBlockers({ ...d, refundTarget: "original" }, e, delivered)).toEqual([]);
    expect(flowBlockers(d, { ...e, allowedRefundTargets: ["original"] }, delivered)).toEqual([]);
  });
  it("builds the request with the chosen target and drops it for exchanges", () => {
    const refund = { ...setReason(EMPTY_DRAFT, "changed_mind", e), refundTarget: "credit" as const };
    expect(buildReturnRequest("l9", refund, e)).toMatchObject({ resolution: "refund", refundTarget: "credit", method: "pickup" });
    const ex = setReason(EMPTY_DRAFT, "too_small", e);
    expect(buildReturnRequest("l9", ex, e)).toMatchObject({ resolution: "exchange", refundTarget: null });
    expect(buildReturnRequest("l9", EMPTY_DRAFT, e)).toBeNull();
  });
});

import { FakePhotoUpload, readyUploadIds, uploadBlockers } from "./model";
import { describe as d3, expect as e3, it as i3 } from "vitest";

d3("photo uploads", () => {
  i3("blocks while uploading or failed and lists ready ids", async () => {
    const photos = [{ uri: "a" }, { uri: "b" }, { uri: "c" }];
    e3(uploadBlockers(photos, { a: { state: "ready", uploadId: "u1" }, b: { state: "uploading" }, c: { state: "failed" } })).toEqual(["uploading", "uploadFailed"]);
    e3(uploadBlockers(photos, { a: { state: "ready", uploadId: "u1" }, b: { state: "ready", uploadId: "u2" }, c: { state: "ready", uploadId: "u3" } })).toEqual([]);
    e3(readyUploadIds(photos, { a: { state: "ready", uploadId: "u1" }, b: { state: "failed" } })).toEqual(["u1"]);
    const up = new FakePhotoUpload(new Set(["bad"]));
    e3((await up.upload("ok")).uploadId).toBe("up-1");
    await e3(up.upload("bad")).rejects.toThrow();
  });
});
