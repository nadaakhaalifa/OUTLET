import { describe, expect, it } from "vitest";
import { ReturnsLineReturns } from "./line-returns";
import { InMemoryReturnRepository } from "./in-memory";
import { record, U } from "../test/repository-contract";

describe("ReturnsLineReturns (orders LineReturnsPort)", () => {
  it("open return blocks (count>0), terminal does not, other order does not leak", async () => {
    const repo = new InMemoryReturnRepository();
    const port = new ReturnsLineReturns(repo);
    const r = record(1);
    await repo.createIfCapacity(r, 3);
    await repo.createIfCapacity(record(2, { orderLineId: U(2009), sellerOrderId: U(3009) }), 3);
    expect([...(await port.openReturnsByLine(U(3000))).values()].reduce((x, y) => x + y, 0)).toBe(1);
    await repo.save({ ...r, state: "REFUNDED", version: 1 }, 0);
    expect((await port.openReturnsByLine(U(3000))).size).toBe(0);
  });
});
