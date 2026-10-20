/** Picks a placeholder-art silhouette from a product title (en/ar keywords). Pure; deterministic fallback by hash. */
import { PRODUCT_KINDS, type ProductKind } from "../../art/product-shapes";

const KEYWORDS: ReadonlyArray<readonly [ProductKind, readonly string[]]> = [
  ["jeans", ["jean", "denim pant", "trouser", "pants", "جينز", "بنطلون"]],
  ["jacket", ["jacket", "coat", "blazer", "جاكيت", "معطف"]],
  ["hoodie", ["hoodie", "sweat", "هودي", "سويت"]],
  ["dress", ["dress", "gown", "abaya", "فستان", "عباية"]],
  ["shorts", ["short", "شورت"]],
  ["shirt", ["shirt", "blouse", "قميص", "بلوزة"]],
  ["tee", ["tee", "t-shirt", "top", "تيشيرت", "توب"]],
  ["sneaker", ["sneaker", "shoe", "trainer", "حذاء", "سنيكر"]],
  ["heel", ["heel", "sandal", "كعب", "صندل"]],
  ["bag", ["bag", "tote", "backpack", "حقيبة", "شنطة"]],
  ["cap", ["cap", "hat", "beanie", "كاب", "قبعة"]],
  ["belt", ["belt", "حزام"]],
  ["scarf", ["scarf", "shawl", "وشاح", "شال", "طرحة"]],
  ["watch", ["watch", "ساعة"]],
  ["sunglasses", ["sunglass", "glasses", "نظارة"]],
  ["tee", ["sock", "جورب", "شراب"]],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

export function kindForTitle(title: string): ProductKind {
  const t = title.toLowerCase();
  for (const [kind, words] of KEYWORDS) if (words.some((w) => t.includes(w))) return kind;
  return PRODUCT_KINDS[hash(t) % PRODUCT_KINDS.length] ?? "tee";
}
