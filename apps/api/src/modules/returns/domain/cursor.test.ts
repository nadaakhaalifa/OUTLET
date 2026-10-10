import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor } from "./cursor";

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64url");
const ID = "0190a1b2-c3d4-4e5f-8a6b-7c8d9e0f1a2b";

describe("returns cursor codec", () => {
  it("round-trips a valid cursor", () => {
    expect(decodeCursor(encodeCursor({ createdAtMs: 1_700_000_000_000, id: ID }))).toEqual({
      createdAtMs: 1_700_000_000_000,
      id: ID,
    });
  });
  it("rejects a non-uuid id made of hyphens", () => {
    expect(decodeCursor(b64(`1:${"-".repeat(36)}`))).toBeNull();
  });
  it("rejects timestamps beyond the Date range", () => {
    expect(decodeCursor(b64(`9000000000000000:${ID}`))).toBeNull();
  });
  it("rejects garbage", () => {
    expect(decodeCursor("!!!")).toBeNull();
    expect(decodeCursor("a".repeat(600))).toBeNull();
  });
});
