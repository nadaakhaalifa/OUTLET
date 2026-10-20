import { describe, expect, it } from "vitest";
import { buildRequestContext, formatTraceparent, parseTraceparent } from "./request-context";
import type { IdGenerator } from "./ports";

const ids: IdGenerator = {
  uuidV7: () => "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
  hex: (n) => "a".repeat(n * 2),
};
const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("traceparent", () => {
  it("parses a valid header", () => {
    expect(parseTraceparent(TP)).toEqual({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      parentSpanId: "00f067aa0ba902b7",
      flags: "01",
    });
  });

  it("rejects malformed, all-zero, ff version and extra fields on version 00", () => {
    for (const bad of [
      undefined,
      "",
      "garbage",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      `${TP}-extra`,
      "00-4bf92f3577b34da6a3ce929d0e0e473-00f067aa0ba902b7-01",
    ]) {
      expect(parseTraceparent(bad), String(bad)).toBeNull();
    }
  });

  it("continues the trace with a new span id and keeps flags", () => {
    const ctx = buildRequestContext({ requestId: undefined, traceparent: TP }, ids);
    expect(ctx.traceId).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(ctx.parentSpanId).toBe("00f067aa0ba902b7");
    expect(ctx.spanId).toBe("a".repeat(16));
    expect(formatTraceparent(ctx)).toBe(`00-4bf92f3577b34da6a3ce929d0e0e4736-${"a".repeat(16)}-01`);
  });

  it("starts a new trace for invalid input and replaces unsafe request ids", () => {
    const ctx = buildRequestContext({ requestId: "bad id\r\nX: y", traceparent: "nope" }, ids);
    expect(ctx.requestId).toBe("0192f3a4-5b6c-7d8e-9f01-23456789abcd");
    expect(ctx.traceId).toBe("a".repeat(32));
    expect(ctx.parentSpanId).toBeNull();
    expect(buildRequestContext({ requestId: "client-req-12345", traceparent: undefined }, ids).requestId).toBe(
      "client-req-12345",
    );
  });
});
