import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import type { Clock } from "../../../platform/ports";
import { resolveInventory } from "../application/inventory";
import type { InventoryTable } from "../domain/bridge";

export const START_MS = 1_800_000_000_000;
export const DAY = 86_400_000;

export class FakeClock implements Clock {
  constructor(private ms = START_MS) {}
  nowMs(): number {
    return this.ms;
  }
  advance(ms: number): void {
    this.ms += ms;
  }
}

/** Sequential UUID-shaped ids, valid for both in-memory and Postgres adapters. */
export function sequentialIds() {
  let n = 0;
  return {
    uuidV7: () => `0192f3a4-5b6c-7d8e-9f01-${String(++n).padStart(12, "0")}`,
    hex: (bytes: number) => "ab".repeat(bytes),
  };
}

const INVENTORY_URL = new URL("../../../../../../docs/privacy/data_inventory.yaml", import.meta.url);

export function loadInventoryTables(): readonly InventoryTable[] {
  return resolveInventory(parse(readFileSync(fileURLToPath(INVENTORY_URL), "utf8")));
}
