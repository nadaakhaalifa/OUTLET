/**
 * The Bag port every screen sees. Signed in: the server bag. Signed out: this phone's guest bag (ADR-0055).
 * The choice is made on each call, so a sign-up at the Checkout gate switches the Bag with no screen change.
 * A signed-in load first retries any merge still pending on the device (same stored key), best effort.
 */
import type { AddLineHint, BagPort, BagSnapshot, Suggestion } from "./model";

export class SessionBagPort implements BagPort {
  constructor(
    private readonly server: BagPort,
    private readonly guest: BagPort,
    private readonly signedIn: () => Promise<boolean>,
    private readonly retryPendingMerge: () => Promise<void> = async () => undefined,
  ) {}

  private async pick(): Promise<BagPort> { return (await this.signedIn()) ? this.server : this.guest; }

  async load(): Promise<BagSnapshot> {
    if (await this.signedIn()) {
      try { await this.retryPendingMerge(); } catch { /* the bag still loads; the merge retries on the next load */ }
      return this.server.load();
    }
    return this.guest.load();
  }
  async inSizeSuggestions(storeId: string): Promise<readonly Suggestion[]> { return (await this.pick()).inSizeSuggestions(storeId); }
  async setSavedForLater(lineId: string, saved: boolean): Promise<void> { return (await this.pick()).setSavedForLater(lineId, saved); }
  async setQuantity(lineId: string, qty: number): Promise<void> { return (await this.pick()).setQuantity(lineId, qty); }
  async removeLine(lineId: string): Promise<void> { return (await this.pick()).removeLine(lineId); }
  async addLine(skuId: string, hint: AddLineHint): Promise<void> { return (await this.pick()).addLine(skuId, hint); }
}
