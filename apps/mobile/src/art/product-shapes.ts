// PLACEHOLDER ART KIT: pure silhouette generators. Every kind draws inside a 240x240 box.
// Roles are resolved to colours by ProductArt; shapes never contain colour values.

export const PRODUCT_KINDS = [
  "tee", "shirt", "dress", "jeans", "shorts", "jacket", "hoodie", "sneaker",
  "heel", "bag", "cap", "belt", "scarf", "watch", "sunglasses",
] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

export type ShapeRole = "base" | "base2" | "shade" | "light" | "accent" | "sole" | "line" | "glass";

export interface ShapeLayer {
  readonly d: string;
  readonly role: ShapeRole;
  /** Apply the soft top-to-bottom shine overlay on top of the fill. */
  readonly shine?: boolean;
  readonly opacity?: number;
}

export const BOX = 240;

const L = (d: string, role: ShapeRole, extra: Partial<ShapeLayer> = {}): ShapeLayer => ({ d, role, ...extra });

const GENERATORS: Record<ProductKind, (v: number) => ShapeLayer[]> = {
  tee: (v) => [
    L("M82 34 L106 24 Q120 46 134 24 L158 34 L208 66 L186 108 L164 94 L164 208 Q120 216 76 208 L76 94 L54 108 L32 66 Z", "base", { shine: true }),
    L("M76 94 L54 108 L32 66 L52 54 L82 34 L88 62 Q80 78 76 94 Z", "base2", { opacity: 0.55 }),
    L(`M106 24 Q120 ${50 + v * 4} 134 24 Q120 ${38 + v * 3} 106 24 Z`, "shade", { opacity: 0.5 }),
    L("M96 120 Q104 150 98 200 L112 202 Q116 150 108 118 Z", "shade", { opacity: 0.14 }),
    L("M140 130 Q150 160 146 204 L156 203 Q160 160 150 128 Z", "light", { opacity: 0.16 }),
    L("M76 200 Q120 210 164 200 L164 208 Q120 216 76 208 Z", "shade", { opacity: 0.25 }),
  ],
  shirt: (v) => [
    L("M82 32 L104 24 L120 50 L136 24 L158 32 L212 58 L220 176 L196 178 L172 104 L170 212 Q120 220 70 212 L68 104 L44 178 L20 176 L28 58 Z", "base", { shine: true }),
    L("M104 24 L120 50 L108 62 L90 38 Z", "light", { opacity: 0.55 }),
    L("M136 24 L120 50 L132 62 L150 38 Z", "light", { opacity: 0.4 }),
    L("M120 50 L120 214", "line", { opacity: 0.35 }),
    L("M44 178 L20 176 L26 120 L50 126 Z", "shade", { opacity: 0.18 }),
    L(`M96 ${90 + v * 6} Q104 150 100 206 L112 207 Q116 150 108 ${88 + v * 6} Z`, "shade", { opacity: 0.12 }),
    L("M123 66 h2 M123 100 h2 M123 134 h2 M123 168 h2", "accent", { opacity: 0.9 }),
  ],
  dress: (v) => [
    L("M92 22 L106 22 Q120 46 134 22 L148 22 L158 92 Q172 160 184 216 Q120 232 56 216 Q68 160 82 92 Z", "base", { shine: true }),
    L("M82 92 Q120 104 158 92 L156 106 Q120 118 84 106 Z", "accent", { opacity: 0.9 }),
    L(`M104 120 Q96 170 80 ${214 - v * 2} L94 218 Q110 170 116 120 Z`, "shade", { opacity: 0.16 }),
    L("M130 120 Q142 170 156 216 L148 218 Q130 170 124 120 Z", "light", { opacity: 0.18 }),
    L("M106 22 Q120 46 134 22 Q120 34 106 22 Z", "shade", { opacity: 0.45 }),
  ],
  jeans: (v) => [
    L("M68 22 L172 22 L186 218 L130 218 L120 96 L110 218 L54 218 Z", "base", { shine: true }),
    L("M68 22 L172 22 L173 38 L67 38 Z", "shade", { opacity: 0.28 }),
    L("M120 38 L120 96", "line", { opacity: 0.4 }),
    L("M78 44 Q92 56 104 44 M136 44 Q148 56 162 44", "accent", { opacity: 0.85 }),
    L(`M72 ${120 + v * 3} Q70 170 62 214 L74 216 Q84 170 86 ${120 + v * 3} Z`, "light", { opacity: 0.2 }),
    L("M144 120 Q150 170 160 216 L150 217 Q140 170 136 120 Z", "shade", { opacity: 0.16 }),
    L("M54 206 L110 206 M130 206 L186 206", "line", { opacity: 0.25 }),
  ],
  shorts: (v) => [
    L("M66 46 L174 46 L192 168 L130 168 L120 106 L110 168 L48 168 Z", "base", { shine: true }),
    L("M66 46 L174 46 L175 62 L65 62 Z", "shade", { opacity: 0.26 }),
    L("M120 62 L120 106", "line", { opacity: 0.4 }),
    L(`M70 ${90 + v * 2} Q66 130 58 162 L72 164 Q80 130 84 ${90 + v * 2} Z`, "light", { opacity: 0.2 }),
    L("M48 158 L110 158 M130 158 L192 158", "accent", { opacity: 0.7 }),
  ],
  jacket: (v) => [
    L("M80 28 L104 20 L120 40 L136 20 L160 28 L214 54 L222 180 L196 182 L174 104 L172 214 Q120 222 68 214 L66 104 L44 182 L18 180 L26 54 Z", "base", { shine: true }),
    L("M104 20 L120 40 L112 112 L92 50 Z", "base2", { opacity: 0.6 }),
    L("M136 20 L120 40 L128 112 L148 50 Z", "light", { opacity: 0.4 }),
    L("M120 40 L120 216", "accent", { opacity: 0.9 }),
    L("M78 150 L102 152 L100 180 L78 178 Z M162 150 L138 152 L140 180 L162 178 Z", "shade", { opacity: 0.24 }),
    L("M44 182 L18 180 L24 126 L50 132 Z", "shade", { opacity: 0.16 }),
    L(`M${60 + v} 100 Q56 150 62 200`, "line", { opacity: 0.22 }),
  ],
  hoodie: (v) => [
    L("M78 52 L100 44 Q120 70 140 44 L162 52 L212 82 L216 190 L192 194 L172 116 L172 214 Q120 222 68 214 L68 116 L48 194 L24 190 L28 82 Z", "base", { shine: true }),
    L("M84 48 Q92 8 120 8 Q148 8 156 48 Q138 66 120 66 Q102 66 84 48 Z", "base2", { opacity: 0.85 }),
    L("M100 46 Q120 74 140 46 Q130 20 120 20 Q110 20 100 46 Z", "shade", { opacity: 0.5 }),
    L("M108 74 L106 110 M132 74 L134 110", "accent", { opacity: 0.95 }),
    L(`M84 ${150 + v * 2} L156 ${150 + v * 2} L164 198 L76 198 Z`, "shade", { opacity: 0.2 }),
    L("M48 194 L24 190 L30 142 L54 148 Z", "shade", { opacity: 0.16 }),
  ],
  sneaker: (v) => [
    L("M14 156 Q14 118 36 112 L66 108 Q84 94 96 84 Q118 96 138 102 Q196 106 220 140 L224 164 Q120 176 14 166 Z", "base", { shine: true }),
    L("M14 156 L224 160 L224 176 Q120 188 14 178 Z", "sole", { opacity: 1 }),
    L(`M14 170 Q120 ${180 + v} 224 168`, "line", { opacity: 0.25 }),
    L("M96 84 Q118 96 138 102 L128 124 Q108 112 90 104 Z", "base2", { opacity: 0.7 }),
    L("M104 98 l14 8 M112 92 l14 8 M120 96 l14 8", "line", { opacity: 0.55 }),
    L("M150 112 Q196 112 220 142 Q196 134 150 128 Z", "accent", { opacity: 0.85 }),
    L("M26 118 Q26 142 30 156 L48 156 Q42 130 46 112 Z", "shade", { opacity: 0.22 }),
  ],
  heel: (v) => [
    L("M34 36 L74 36 Q84 98 134 128 Q180 138 214 146 Q226 160 208 168 L128 166 Q92 160 64 124 Q40 90 34 36 Z", "base", { shine: true }),
    L("M56 120 L74 124 L66 212 L56 212 Z", "base2"),
    L("M34 36 L74 36 L72 56 L35 56 Z", "shade", { opacity: 0.3 }),
    L("M134 128 Q180 138 214 146 Q226 160 208 168 L132 164 Q150 148 134 128 Z", "light", { opacity: 0.22 }),
    L(`M120 ${164 + v} Q170 172 210 166`, "sole"),
    L("M52 210 L70 210", "line", { opacity: 0.6 }),
  ],
  bag: (v) => [
    L("M88 92 Q88 30 120 30 Q152 30 152 92", "line", { opacity: 0.85 }),
    L("M40 84 L200 84 L214 206 Q120 218 26 206 Z", "base", { shine: true }),
    L("M40 84 L200 84 L204 128 Q120 150 36 128 Z", "base2", { opacity: 0.8 }),
    L(`M112 ${128 + v} L128 ${128 + v} L128 ${146 + v} L112 ${146 + v} Z`, "accent"),
    L("M52 150 Q60 180 54 204 L70 205 Q76 180 66 148 Z", "shade", { opacity: 0.14 }),
    L("M26 206 Q120 218 214 206 L214 212 Q120 224 26 212 Z", "shade", { opacity: 0.3 }),
  ],
  cap: (v) => [
    L("M46 138 Q40 56 120 50 Q200 56 194 138 Q120 150 46 138 Z", "base", { shine: true }),
    L("M120 50 Q120 100 118 142 M120 50 Q86 78 80 140 M120 50 Q154 78 160 140", "line", { opacity: 0.3 }),
    L(`M46 138 Q120 154 194 138 Q230 ${150 + v * 4} 226 170 Q150 150 100 160 Q60 166 46 138 Z`, "base2", { opacity: 0.95 }),
    L("M120 46 m-6 0 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0 Z", "accent"),
    L("M46 138 Q120 150 194 138 L194 146 Q120 160 46 146 Z", "shade", { opacity: 0.28 }),
  ],
  belt: (v) => [
    L(`M10 ${96 + v * 4} Q120 70 230 ${96 + v * 4} L230 ${124 + v * 4} Q120 98 10 ${124 + v * 4} Z`, "base", { shine: true }),
    L(`M10 ${120 + v * 4} Q120 94 230 ${120 + v * 4}`, "line", { opacity: 0.25 }),
    L("M152 80 L186 84 L186 128 L152 126 Z", "accent"),
    L("M160 90 L178 92 L178 118 L160 116 Z", "shade", { opacity: 0.45 }),
    L("M60 94 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M80 90 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0 M100 87 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0", "shade", { opacity: 0.5 }),
  ],
  scarf: (v) => [
    L(`M52 24 Q120 ${8 + v * 4} 188 24 L200 150 Q150 ${170 + v * 4} 96 150 Z`, "base", { shine: true }),
    L("M150 28 L190 24 L220 200 L172 204 Z", "base2", { opacity: 0.9 }),
    L("M60 60 Q120 76 190 56 M70 92 Q130 106 196 86 M82 124 Q138 136 204 118", "accent", { opacity: 0.8 }),
    L("M174 204 L220 200 M176 210 L224 206 M178 216 L228 212", "line", { opacity: 0.45 }),
    L("M96 150 Q150 170 200 150 L204 164 Q150 186 100 164 Z", "shade", { opacity: 0.2 }),
  ],
  watch: (v) => [
    L("M92 8 L148 8 L152 70 L88 70 Z", "base2", { shine: true }),
    L("M88 170 L152 170 L148 232 L92 232 Z", "base2", { shine: true }),
    L("M120 120 m-60 0 a60 60 0 1 0 120 0 a60 60 0 1 0 -120 0", "accent", { shine: true }),
    L("M120 120 m-50 0 a50 50 0 1 0 100 0 a50 50 0 1 0 -100 0", "glass"),
    L(`M120 120 L120 ${78 + v * 2} M120 120 L${150 - v * 2} 138`, "line", { opacity: 0.9 }),
    L("M120 78 v6 M120 156 v6 M78 120 h6 M156 120 h6", "line", { opacity: 0.6 }),
    L("M180 114 h10 v12 h-10 Z", "accent"),
  ],
  sunglasses: (v) => [
    L("M18 90 L18 80 L34 78", "line", { opacity: 0.9 }),
    L("M222 90 L222 80 L206 78", "line", { opacity: 0.9 }),
    L("M26 84 L112 84 Q116 140 78 150 Q36 152 26 84 Z", "base", { shine: true }),
    L("M214 84 L128 84 Q124 140 162 150 Q204 152 214 84 Z", "base", { shine: true }),
    L("M36 92 L104 92 Q106 132 78 140 Q46 140 36 92 Z", "glass"),
    L("M204 92 L136 92 Q134 132 162 140 Q194 140 204 92 Z", "glass"),
    L(`M112 ${92 + v} Q120 84 128 ${92 + v}`, "line", { opacity: 0.95 }),
    L("M44 100 L64 100 L48 116 Z", "light", { opacity: 0.4 }),
  ],
};

export function shapeFor(kind: ProductKind, variant = 0): readonly ShapeLayer[] {
  return GENERATORS[kind](variant % 4);
}
