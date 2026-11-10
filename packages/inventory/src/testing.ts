import type { SoldOutFlagPort } from "./application/ports.js";

/** TEST ONLY. In-memory SoldOutFlagPort. `has` exists for assertions; production code never reads the flag as truth. */
export class InMemorySoldOutFlags implements SoldOutFlagPort {
  private readonly flags = new Set<string>();
  readonly calls: string[] = [];
  set(skuId: string, locationId: string): Promise<void> {
    this.flags.add(`${skuId}|${locationId}`);
    this.calls.push(`set ${skuId}`);
    return Promise.resolve();
  }
  clear(skuId: string, locationId: string): Promise<void> {
    this.flags.delete(`${skuId}|${locationId}`);
    this.calls.push(`clear ${skuId}`);
    return Promise.resolve();
  }
  has(skuId: string, locationId: string): boolean {
    return this.flags.has(`${skuId}|${locationId}`);
  }
}
