import { ApiError, dataOf, type schemas } from "../../services/api-client";
import { guard, money, pick, type AdapterContext } from "../../services/wire";
import { LOW_STOCK_MAX, type PdpPort, type Product, type SizeRecommendation, type CommunityFit } from "./model";
import type { SizeProfilePort } from "../size-profile/model";
import type { BagPort } from "../bag/model";
import type { WishlistIntent, WishlistsPort } from "../wishlists/model";

const CONDITION: Readonly<Record<schemas.Product["condition"], Product["condition"]>> = {
  new_with_tags: "newWithTags", new_without_tags: "newWithoutTags", sample: "sample", minor_defect: "minorDefect",
};
const TENDENCY: Readonly<Record<NonNullable<schemas.FitRecommendation["community_fit"]>["tendency"], CommunityFit["direction"]>> = {
  runs_small: "runsSmall", true_to_size: "trueToSize", runs_large: "runsLarge",
};

/** Statutory minimum windows (master prompt B5), used only because the wire carries one window, not both. */
const STATUTORY_CHANGE_OF_MIND_DAYS = 14;
const STATUTORY_DEFECT_DAYS = 30;

/** GET /v1/products/{id} (+ fit). Add-to-bag and save-with-intent go through the Bag and Wishlists ports. */
export class ApiPdpPort implements PdpPort {
  constructor(
    private readonly ctx: AdapterContext,
    private readonly bag: BagPort,
    private readonly wishlists: WishlistsPort,
    private readonly sizeProfiles: SizeProfilePort,
  ) {}

  load(productId: string): Promise<Product> {
    return guard(async () => {
      const p = dataOf(await this.ctx.client.getProduct({ path: { productId } }));
      const lang = this.ctx.locale();
      const fit = await this.fit(productId);
      const block = p.price;
      const claim: Product["claim"] =
        block.badge === "verified_discount" && block.reference_price !== undefined && block.reference_price !== null
          ? { referencePrice: money(block.reference_price), lowestIn30Days: false }
          : block.badge === "lowest_30d"
            ? { referencePrice: money(block.price), lowestIn30Days: true }
            : null;
      const identity = p.seller_legal_identity;
      const recommendation: SizeRecommendation | null = fit === null ? null : { sizeLabel: fit.size, confidence: fit.confidence };
      const community: CommunityFit | null =
        fit?.community_fit !== undefined && fit.community_fit !== null ? { direction: TENDENCY[fit.community_fit.tendency], sampleCount: fit.community_fit.sample_size } : null;
      return {
        id: p.id,
        title: pick(p.title, lang),
        price: money(block.price),
        claim,
        isLaunchPrice: block.badge === "launch_price",
        imageCount: p.images.length,
        seller: {
          storeName: pick(p.store.name, lang),
          legalName: identity?.legal_name ?? "",
          commercialRegisterNo: identity?.commercial_register_no ?? "",
          taxCardNo: identity?.tax_card_no ?? "",
          governorate: identity?.governorate ?? "",
        },
        // The wire only reports units_left when it is <= 5; "available" without a count is shown as plain in-stock.
        sizes: p.skus.map((s) => ({ sku: s.id, label: s.size_label, stock: s.available ? (s.units_left ?? LOW_STOCK_MAX + 1) : 0 })),
        recommendation,
        communityFit: community,
        condition: CONDITION[p.condition],
        defectNote: null,
        deliveryDaysMin: p.delivery_eta?.min_days ?? null,
        deliveryDaysMax: p.delivery_eta?.max_days ?? null,
        returnPolicy: p.return_eligibility.returnable
          ? { kind: "standard", changeOfMindDays: p.return_eligibility.window_days ?? STATUTORY_CHANGE_OF_MIND_DAYS, defectDays: STATUTORY_DEFECT_DAYS }
          : { kind: "nonReturnable" },
        status: "active",
      };
    });
  }

  /** Fit needs a size profile; no profile (or none applicable) means no recommendation, not an error. */
  private async fit(productId: string): Promise<schemas.FitRecommendation | null> {
    const profiles = await this.sizeProfiles.list();
    const mine = profiles.find((x) => x.kind === "me") ?? profiles[0];
    if (mine === undefined) return null;
    try {
      return dataOf(await this.ctx.client.getProductFit({ path: { productId }, query: { profile_id: mine.id } }));
    } catch (e) {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500) return null;
      throw e;
    }
  }

  addToBag(sku: string): Promise<void> {
    return this.bag.addLine(sku, { storeId: "", storeName: "", title: "", sizeLabel: null, unitPrice: 0n });
  }

  saveWithIntent(productId: string, intent: WishlistIntent): Promise<void> {
    return this.wishlists.saveItem(productId, intent, { title: "", price: 0n });
  }
}
