import { describe, expect, it } from "vitest";
import { evaluateReturnerStanding } from "./serial";

describe("serial returner policy", () => {
  it("needs at least 10 delivered orders", () => {
    expect(evaluateReturnerStanding({ deliveredOrders: 9, returnedOrders: 9 }).freeReturnsRemoved).toBe(false);
    expect(evaluateReturnerStanding({ deliveredOrders: 10, returnedOrders: 7 }).freeReturnsRemoved).toBe(true);
  });
  it("is strictly above 60 percent", () => {
    expect(evaluateReturnerStanding({ deliveredOrders: 10, returnedOrders: 6 }).freeReturnsRemoved).toBe(false);
    expect(evaluateReturnerStanding({ deliveredOrders: 20, returnedOrders: 12 }).freeReturnsRemoved).toBe(false);
    expect(evaluateReturnerStanding({ deliveredOrders: 20, returnedOrders: 13 }).freeReturnsRemoved).toBe(true);
    expect(evaluateReturnerStanding({ deliveredOrders: 1000, returnedOrders: 601 }).freeReturnsRemoved).toBe(true);
  });
  it("reports the rate in basis points", () => {
    expect(evaluateReturnerStanding({ deliveredOrders: 3, returnedOrders: 1 }).rateBps).toBe(3333);
    expect(evaluateReturnerStanding({ deliveredOrders: 0, returnedOrders: 0 }).rateBps).toBe(0);
  });
  it("rejects impossible counts", () => {
    expect(() => evaluateReturnerStanding({ deliveredOrders: 2, returnedOrders: 3 })).toThrow();
    expect(() => evaluateReturnerStanding({ deliveredOrders: -1, returnedOrders: 0 })).toThrow();
    expect(() => evaluateReturnerStanding({ deliveredOrders: 1.5, returnedOrders: 0 })).toThrow();
  });
});
