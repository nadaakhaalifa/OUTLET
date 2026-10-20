import { describe, expect, it } from "vitest";
import { loadInventoryTables } from "../test/fixtures";
import { INVENTORY_SNAPSHOT } from "./inventory.snapshot";

describe("inventory snapshot", () => {
  it("matches docs/privacy/data_inventory.yaml (regenerate the snapshot when the inventory changes)", () => {
    expect(INVENTORY_SNAPSHOT).toEqual(loadInventoryTables());
  });
});
