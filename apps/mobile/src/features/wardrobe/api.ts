import { dataOf, type schemas } from "../../services/api-client";
import { piastres, type AdapterContext } from "../../services/wire";
import { AiFailure, aiGuard } from "../ai-failure";
import type { MissingSlot, Outfit, Slot } from "../stylist/model";
import { outfitFromWire, slotOf } from "../stylist/wire-outfit";
import {
  CATEGORIES, COLOURS, FORMALITY, MATERIALS, MAX_PHOTO_BYTES, PATTERNS, WARDROBE_SEASONS, isSafeUploadUrl, photoTypeOf,
  type Category, type Colour, type Formality, type Material, type Pattern, type WardrobeAttributes, type WardrobeItem, type WardrobeLook, type WardrobeLookRequest, type WardrobePort, type WardrobeSeason,
} from "./model";

const pickOf = <T extends string>(all: readonly T[], v: string | undefined): T | null => all.find((x) => x === v) ?? null;

function attributesOf(a: schemas.WardrobeAttributes): WardrobeAttributes {
  const formality = a.formality;
  return {
    category: pickOf<Category>(CATEGORIES, a.category),
    palette: (a.palette ?? []).flatMap((c) => pickOf<Colour>(COLOURS, c) ?? []),
    pattern: pickOf<Pattern>(PATTERNS, a.pattern),
    formality: FORMALITY.find((f) => f === formality) ?? null,
    seasons: (a.seasons ?? []).flatMap((s) => pickOf<WardrobeSeason>(WARDROBE_SEASONS, s) ?? []),
    material: pickOf<Material>(MATERIALS, a.material),
    modest: a.modest ?? null,
  };
}

/** Only set fields go on the wire (the API refuses unknown or empty values). */
function wireAttributes(a: WardrobeAttributes): schemas.WardrobeAttributes {
  return {
    ...(a.category !== null ? { category: a.category } : {}),
    ...(a.palette.length > 0 ? { palette: [...a.palette] } : {}),
    ...(a.pattern !== null ? { pattern: a.pattern } : {}),
    ...(a.formality !== null ? { formality: a.formality satisfies Formality } : {}),
    ...(a.seasons.length > 0 ? { seasons: [...a.seasons] } : {}),
    ...(a.material !== null ? { material: a.material } : {}),
    ...(a.modest !== null ? { modest: a.modest } : {}),
  };
}

function itemOf(i: schemas.WardrobeItem): WardrobeItem {
  return {
    id: i.id,
    attributes: attributesOf(i.attributes),
    source: i.attributes_source,
    needsReview: i.needs_review,
    complete: i.complete,
    photo: i.photo.state,
    version: i.version,
  };
}

/**
 * /v1/me/wardrobe/*. Photo add: read the picked file, issueWardrobeUpload (type + size), PUT the bytes to the
 * returned signed URL, then createWardrobeItem with the upload id. Nothing is sent before the shopper taps save.
 */
export class ApiWardrobePort implements WardrobePort {
  constructor(private readonly ctx: AdapterContext) {}

  list(): Promise<readonly WardrobeItem[]> {
    return aiGuard(async () => {
      const out: WardrobeItem[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 8; page += 1) {
        const r = dataOf(await this.ctx.client.listWardrobeItems({ query: { limit: 50, ...(cursor !== undefined ? { cursor } : {}) } }));
        out.push(...r.items.map(itemOf));
        if (r.next_cursor === "" || r.items.length === 0) break;
        cursor = r.next_cursor;
      }
      return out;
    });
  }

  add(input: { photoUri: string | null; attributes: WardrobeAttributes }): Promise<WardrobeItem> {
    return aiGuard(async () => {
      let uploadId: string | undefined;
      if (input.photoUri !== null) {
        const file = await fetch(input.photoUri);
        const blob = await file.blob();
        if (blob.size <= 0 || blob.size > MAX_PHOTO_BYTES) throw new AiFailure("rejected");
        const contentType = photoTypeOf(blob.type, input.photoUri);
        const slot = dataOf(await this.ctx.client.issueWardrobeUpload({ body: { content_type: contentType, size_bytes: blob.size } }));
        if (!isSafeUploadUrl(slot.url)) throw new AiFailure("failed");
        const put = await fetch(slot.url, { method: slot.method, headers: { ...slot.headers, "Content-Type": contentType }, body: blob });
        if (!put.ok) throw new AiFailure("failed");
        uploadId = slot.upload_id;
      }
      const attrs = wireAttributes(input.attributes);
      const body: schemas.WardrobeItemCreate = {
        ...(uploadId !== undefined ? { upload_id: uploadId } : {}),
        ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
      };
      return itemOf(dataOf(await this.ctx.client.createWardrobeItem({ body })));
    });
  }

  suggest(id: string): Promise<WardrobeItem> {
    return aiGuard(async () => itemOf(dataOf(await this.ctx.client.suggestWardrobeAttributes({ path: { itemId: id } }))));
  }

  update(id: string, attributes: WardrobeAttributes, expectedVersion: number): Promise<WardrobeItem> {
    return aiGuard(async () =>
      itemOf(dataOf(await this.ctx.client.updateWardrobeItem({ path: { itemId: id }, body: { attributes: wireAttributes(attributes), expected_version: expectedVersion } }))),
    );
  }

  remove(id: string): Promise<void> {
    return aiGuard(async () => {
      dataOf(await this.ctx.client.deleteWardrobeItem({ path: { itemId: id } }));
    });
  }

  clear(): Promise<void> {
    return aiGuard(async () => {
      dataOf(await this.ctx.client.clearWardrobe());
    });
  }

  photoUrl(id: string): Promise<string | null> {
    return aiGuard(async () => dataOf(await this.ctx.client.getWardrobeItemPhoto({ path: { itemId: id } })).url);
  }

  completeLook(req: WardrobeLookRequest): Promise<WardrobeLook> {
    return aiGuard(async () => {
      const r = dataOf(
        await this.ctx.client.completeFromWardrobe({
          body: { kind: req.kind, modest: req.modest, ...(req.budget !== null ? { budget_piastres: req.budget.toString() } : {}) },
        }),
      );
      const outfits: Outfit[] = [];
      const ownedSlots: Record<string, readonly Slot[]> = {};
      for (const o of r.outfits) {
        outfits.push(outfitFromWire({ id: o.outfit_id, items: o.items, per_store: [], missing: o.missing.map((m) => ({ slot: m.slot, add_piastres: m.add_piastres })) }));
        ownedSlots[o.outfit_id] = o.owned_slots.map((s) => slotOf(s)).filter((s): s is Slot => s !== null);
      }
      const shortfall: MissingSlot[] = [];
      for (const m of r.shortfall) {
        const slot = slotOf(m.slot);
        if (slot !== null) shortfall.push({ slot, shortfall: piastres(m.add_piastres) });
      }
      return { outfits, ownedSlots, ownedOnly: r.owned_only, shortfall, source: r.source === "ml" && r.fallback_reason === "none" ? "ai" : "rules", remainingToday: r.remaining_today };
    });
  }
}
