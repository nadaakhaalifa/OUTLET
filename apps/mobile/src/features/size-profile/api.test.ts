import { describe, expect, it, vi } from "vitest";
import type { OutletClient } from "../../services/api-client";
import type { AdapterContext } from "../../services/wire";
import { ApiSizeProfilePort, fromWireMeasurements, toWireMeasurements } from "./api";

type Call = (...a: unknown[]) => Promise<unknown>;
const ok = (data: unknown, etag: string | null = null) => Promise.resolve({ data, etag, notModified: false });
const port = (client: Record<string, Call>) =>
  new ApiSizeProfilePort({ client: client as unknown as OutletClient, locale: () => "ar", nowMs: () => 0, deviceId: () => "device-12345" } as AdapterContext);

const wireProfile = (over: Record<string, unknown> = {}) => ({
  id: "p1", kind: "me", label: "Me", fit_preference: "regular", modest_fit: true, measurements: { height_cm: 170.5, waist_cm: 72 }, usual_size: { size_label: "M" }, ...over,
});

describe("measurement conversion", () => {
  it("converts app tenths to wire cm and back without float drift", () => {
    expect(toWireMeasurements({ height: 1705, weight: 655, waist: 720 })).toEqual({ height_cm: 170.5, weight_kg: 65.5, waist_cm: 72 });
    expect(fromWireMeasurements({ height_cm: 170.5, waist_cm: 72.3 } as never)).toEqual({ height: 1705, waist: 723 });
  });

  it("wrist has no wire field and is never sent", () => {
    expect(toWireMeasurements({ wrist: 150 })).toEqual({});
  });

  it("round trips every sent key", () => {
    const m = { height: 1700, bust: 900, hip: 980, footLength: 255 };
    expect(fromWireMeasurements(toWireMeasurements(m))).toEqual(m);
  });

  it("missing wire measurements read as empty", () => {
    expect(fromWireMeasurements(undefined)).toEqual({});
  });
});

describe("ApiSizeProfilePort", () => {
  it("list follows every page and maps profiles, defaulting modest fit and usual size", async () => {
    const listSizeProfiles = vi.fn()
      .mockImplementationOnce(() => ok({ items: [wireProfile()], page: { next_cursor: "c2", has_more: true } }))
      .mockImplementationOnce(() => ok({ items: [wireProfile({ id: "p2", modest_fit: undefined, usual_size: undefined, measurements: undefined })], page: { next_cursor: null, has_more: false } }));
    const list = await port({ listSizeProfiles }).list();
    expect(listSizeProfiles).toHaveBeenNthCalledWith(1, { query: { limit: 50 } });
    expect(listSizeProfiles).toHaveBeenNthCalledWith(2, { query: { limit: 50, cursor: "c2" } });
    expect(list[0]).toEqual({ id: "p1", kind: "me", label: "Me", fitPreference: "regular", modestFit: true, measurements: { height: 1705, waist: 720 }, usualSize: "M" });
    expect(list[1]).toMatchObject({ id: "p2", modestFit: false, measurements: {}, usualSize: null });
  });

  it("creating sends the wire body, omitting the usual size when absent", async () => {
    const createSizeProfile = vi.fn(() => ok(wireProfile()));
    await port({ createSizeProfile }).save({ kind: "me", label: "Me", fitPreference: "regular", modestFit: false, measurements: { height: 1700 }, usualSize: null });
    expect(createSizeProfile).toHaveBeenCalledWith({ body: { label: "Me", kind: "me", fit_preference: "regular", modest_fit: false, measurements: { height_cm: 170 } } });
  });

  it("updating reads the ETag first and sends it as If-Match", async () => {
    const getSizeProfile = vi.fn(() => ok(wireProfile(), "etag-9"));
    const updateSizeProfile = vi.fn(() => ok(wireProfile({ label: "Mine" })));
    const saved = await port({ getSizeProfile, updateSizeProfile }).save({ id: "p1", kind: "me", label: "Mine", fitPreference: "snug", modestFit: false, measurements: {}, usualSize: "L" });
    expect(updateSizeProfile).toHaveBeenCalledWith({
      path: { profileId: "p1" }, headers: { "If-Match": "etag-9" },
      body: { label: "Mine", kind: "me", fit_preference: "snug", modest_fit: false, measurements: {}, usual_size: { size_label: "L" } },
    });
    expect(saved.label).toBe("Mine");
  });

  it("updating without an ETag fails instead of overwriting blindly", async () => {
    const updateSizeProfile = vi.fn();
    await expect(port({ getSizeProfile: () => ok(wireProfile(), null), updateSizeProfile }).save({ id: "p1", kind: "me", label: "x", fitPreference: "regular", modestFit: false, measurements: {}, usualSize: null }))
      .rejects.toMatchObject({ kind: "failed" });
    expect(updateSizeProfile).not.toHaveBeenCalled();
  });

  it("remove deletes by id", async () => {
    const deleteSizeProfile = vi.fn(() => ok({}));
    await port({ deleteSizeProfile }).remove("p1");
    expect(deleteSizeProfile).toHaveBeenCalledWith({ path: { profileId: "p1" } });
  });
});
