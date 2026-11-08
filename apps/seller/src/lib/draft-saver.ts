import type { ApiFailure, ApiResult, ProductWire, SellerApi } from "../client/seller-api";
import { conditionOf, conditionSection, defectCardBody, detailsSection, priceSection, type RequiredAttribute, type WizardState } from "./wizard-model";

export type SaveStatus = "saving" | "saved" | "error" | "idle";

export interface SaverHooks {
  readonly status: (s: SaveStatus) => void;
  /** Server activation reasons after each successful save (null never: only called with a list). */
  readonly reasons: (r: string[]) => void;
  readonly failure: (f: ApiFailure) => void;
  /** The product was reloaded from the server after a version conflict. */
  readonly conflict: (p: ProductWire) => void;
  readonly draftCreated: (id: string) => void;
}

export interface SaverOptions {
  readonly debounceMs?: number;
  readonly initial?: { readonly product: ProductWire; readonly state: WizardState; readonly defs: readonly RequiredAttribute[] };
}

interface Sent {
  condition: string;
  details: string;
  price: string;
  card: string;
}

/**
 * Debounced, serialized autosave. At most one save runs at a time; edits made while it runs trigger exactly one more pass.
 * A section is sent only when it is complete and changed. Every PATCH carries If-Match = the last known version; a 409 reloads
 * the product and retries once.
 */
export class DraftSaver {
  productId: string | undefined;
  version = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private dirty = false;
  private latest: { state: WizardState; defs: readonly RequiredAttribute[] } | undefined;
  private sent: Sent = { condition: "", details: "", price: "", card: "" };
  private readonly debounceMs: number;

  constructor(
    private readonly api: SellerApi,
    private readonly hooks: SaverHooks,
    opts: SaverOptions = {},
  ) {
    this.debounceMs = opts.debounceMs ?? 800;
    if (opts.initial !== undefined) {
      this.productId = opts.initial.product.id;
      this.version = opts.initial.product.version;
      this.sent = this.keys(opts.initial.state, opts.initial.defs);
      // The server already holds a defect card for the loaded product only when it has one.
      if (opts.initial.product.defect_card === null || opts.initial.product.defect_card === undefined) this.sent.card = "";
    }
  }

  private keys(state: WizardState, defs: readonly RequiredAttribute[]): Sent {
    const card = defectCardBody(state);
    return {
      condition: JSON.stringify(conditionSection(state)),
      details: JSON.stringify(detailsSection(state, defs)),
      price: JSON.stringify(priceSection(state)),
      card: card === null ? "" : JSON.stringify([conditionOf(state.condition).grade, card]),
    };
  }

  /** Schedules a save after the debounce window. */
  update(state: WizardState, defs: readonly RequiredAttribute[]): void {
    this.latest = { state, defs };
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.debounceMs);
  }

  /** Saves now (the "Save draft" button, step changes, publish). Resolves when the queue is drained. */
  async flush(): Promise<void> {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.running !== undefined) {
      this.dirty = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.dirty = false;
        await this.cycle();
      } while (this.isDirty());
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private currentId(): string | null {
    return this.productId ?? null;
  }

  private isDirty(): boolean {
    return this.dirty;
  }

  /** A draft must exist before a photo can be uploaded to it. */
  async ensureDraft(state: WizardState): Promise<string | null> {
    if (this.productId !== undefined) return this.productId;
    if (state.categoryId === "") return null;
    return (await this.create(state)) ? this.currentId() : null;
  }

  private async create(state: WizardState): Promise<boolean> {
    const r = await this.api.createDraft(conditionOf(state.condition).grade, state.categoryId);
    if (!r.ok) {
      this.fail(r);
      return false;
    }
    this.productId = r.data.id;
    this.version = r.data.version;
    this.hooks.draftCreated(r.data.id);
    return true;
  }

  private fail(f: ApiFailure): void {
    this.hooks.status("error");
    this.hooks.failure(f);
  }

  private async cycle(): Promise<void> {
    const snap = this.latest;
    if (snap === undefined) return;
    const { state, defs } = snap;
    if (this.productId === undefined) {
      if (state.categoryId === "") return;
      this.hooks.status("saving");
      if (!(await this.create(state))) return;
    }
    const id = this.productId;
    if (id === undefined) return;
    this.hooks.status("saving");
    const k = this.keys(state, defs);
    const body: Record<string, unknown> = {};
    const cond = conditionSection(state);
    const det = detailsSection(state, defs);
    const price = priceSection(state);
    if (cond !== null && k.condition !== this.sent.condition) body.condition = cond;
    if (det !== null && k.details !== this.sent.details) body.details = det;
    if (price !== null && k.price !== this.sent.price) body.price = price;
    if (Object.keys(body).length > 0) {
      const r = await this.patchWithRetry(id, body);
      if (r === null) return;
      if (cond !== null) this.sent.condition = k.condition;
      if (det !== null) this.sent.details = k.details;
      if (price !== null) this.sent.price = k.price;
    }
    const card = defectCardBody(state);
    if (card !== null && k.card !== this.sent.card && (cond === null || this.sent.condition === k.condition)) {
      const r = await this.api.defectCard(id, this.version, card);
      if (!r.ok) {
        if (r.code === "version-conflict") await this.reload(id);
        this.fail(r);
        return;
      }
      this.sent.card = k.card;
      const fresh = await this.api.getProduct(id);
      if (fresh.ok) this.version = fresh.data.version;
    }
    const ready = await this.api.readiness(id);
    if (ready.ok) this.hooks.reasons(ready.data.blocked_reasons);
    this.hooks.status("saved");
  }

  private async patchWithRetry(id: string, body: object): Promise<ProductWire | null> {
    let r: ApiResult<ProductWire> = await this.api.patch(id, this.version, body);
    if (!r.ok && r.code === "version-conflict") {
      // Someone (another tab, a colleague) saved first: take their version, tell the user, and apply our edit on top once.
      const fresh = await this.reload(id);
      if (fresh !== null) r = await this.api.patch(id, this.version, body);
    }
    if (!r.ok) {
      this.fail(r);
      return null;
    }
    this.version = r.data.version;
    return r.data;
  }

  private async reload(id: string): Promise<ProductWire | null> {
    const fresh = await this.api.getProduct(id);
    if (!fresh.ok) return null;
    this.version = fresh.data.version;
    this.hooks.conflict(fresh.data);
    return fresh.data;
  }

  dispose(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
  }
}
