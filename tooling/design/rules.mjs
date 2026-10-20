// Design-system guardrail rules (single source). Consumed by eslint.config.mjs and check-debt.mjs.
// Each rule carries a stable code in its message so the debt baseline can be keyed per file and per rule.
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = join(here, "debt-baseline.json");

/** Radius scale from packages/ui-tokens (radius) plus 0. Keep in sync: a unit test asserts this. */
export const RADIUS_SCALE = [0, 4, 8, 14, 16, 18, 24, 32, 999];

/** The maximum iPad zoom, read from the tokens (the one constant) so lint messages never hard-code it. */
function ipadZoom() {
  try {
    const src = readFileSync(join(here, "../../packages/ui-tokens/src/index.ts"), "utf8");
    const m = /export const IPAD_ZOOM = ([0-9.]+);/.exec(src);
    if (m) return Number(m[1]);
  } catch { /* fall through */ }
  return 1;
}
const ZOOM = ipadZoom();
const SHORTFALL_PCT = Math.round((1 - 1 / ZOOM) * 100);

export const GLOBS = {
  // Web: the shared kit and the new chart spike code only. Existing web app code is not yet linted (see docs/research/chart-spike-results.md).
  web: ["packages/ui-web/src/**/*.{ts,tsx}", "apps/admin-web/src/app/spike/**/*.{ts,tsx}"],
  all: ["apps/mobile/src/**/*.{ts,tsx}", "packages/ui-native/src/**/*.{ts,tsx}", "packages/ui-web/src/**/*.{ts,tsx}", "apps/admin-web/src/app/spike/**/*.{ts,tsx}"],
  allIgnores: [
    "**/*.test.{ts,tsx}", "**/*.spec.{ts,tsx}", "**/test/**", "**/__tests__/**",
    "apps/mobile/src/art/**", "packages/ui-tokens/**",
  ],
  screens: ["apps/mobile/src/features/**/*.{ts,tsx}", "apps/mobile/src/app/**/*.{ts,tsx}"],
};

const radiusExclusions = RADIUS_SCALE.map((n) => `[value.value!=${n}]`).join("");

/** code -> restricted-syntax entry. `scope`: "all" (mobile + kit) or "screens" (features + app). */
export const SYNTAX_RULES = {
  "DS-COLOR": {
    scope: "all",
    selector: "Literal[value=/^(#[0-9a-fA-F]{3,8}|(rgb|hsl)a?\\(.*)$/]",
    message: "[DS-COLOR] Raw colour literal. Use a semantic token from @outlet/ui-tokens (useTheme().colors).",
  },
  "DS-FONT": {
    scope: "screens",
    selector: "Property[key.name=/^(fontSize|lineHeight|fontFamily|fontWeight|letterSpacing)$/][value.type='Literal']",
    message: "[DS-FONT] Raw typography value in a screen. Use a <Text variant=...> from the kit.",
  },
  "DS-RADIUS": {
    scope: "all",
    selector: `Property[key.name=/^border.*Radius$/][value.type='Literal']${radiusExclusions}`,
    message: "[DS-RADIUS] Border radius outside the token scale. Use radius.* from @outlet/ui-tokens.",
  },
  // iPad adaptation (ADR-0054). Window size is read once, in the kit theme. Screens read `useLayout()` / `useTheme()`.
  "DS-RN-WINDOW": {
    scope: "all",
    selector: "MemberExpression[object.name='Platform'][property.name='isPad']",
    message: "[DS-RN-WINDOW] Platform.isPad is banned: the layout depends on the window width (size classes). Use useLayout() from @outlet/ui-native.",
  },
  // A raw layout number does not zoom: it renders 25% too small on iPad. Tokens from useTheme() are already zoomed; s(n) scales a raw one.
  "DS-RN-RAW-SIZE": {
    scope: "screens",
    selector: [
      "Property[key.name=/^(width|height|minHeight|maxWidth|gap|rowGap|columnGap|top|bottom|start|end|(padding|margin)(Horizontal|Vertical|Top|Bottom|Start|End|Left|Right)?)$/][value.type='Literal'][value.raw=/^[0-9]/][value.value>=2]",
      "JSXOpeningElement[name.name='Icon'] > JSXAttribute[name.name='size'] > JSXExpressionContainer > Literal[raw=/^[0-9]/][value>=2]",
    ].join(", "),
    message: `[DS-RN-RAW-SIZE] Raw layout number in a screen does not zoom: it renders ${SHORTFALL_PCT}% too small next to zoomed neighbours at the full iPad zoom (${ZOOM}x). Use useTheme() tokens (spacing, radii, controls, gutter) or s(n) from useLayout().`,
  },
};

const RN_BANNED = ["Text", "TextInput", "Button", "TouchableOpacity"];

/** code -> restricted-imports path entry (screens only). */
export const IMPORT_RULES = {
  "DS-RN-COMPONENT": {
    name: "react-native",
    importNames: RN_BANNED,
    message: "[DS-RN-COMPONENT] Import Text/TextInput/Button/TouchableOpacity from the kit (@outlet/ui-native), not react-native.",
  },
  "DS-RN-WINDOW": {
    name: "react-native",
    importNames: ["useWindowDimensions", "Dimensions"],
    message: "[DS-RN-WINDOW] Do not read the window in a screen. Use useLayout() from @outlet/ui-native (size class, z, effectiveWidth, s()).",
  },
  "DS-MOTION-ANIMATED": {
    name: "react-native",
    importNames: ["Animated"],
    message: "[DS-MOTION] Use the kit motion helpers, not react-native Animated, in screens.",
  },
  "DS-MOTION-REANIMATED": {
    name: "react-native-reanimated",
    message: "[DS-MOTION] Use the kit motion helpers, not react-native-reanimated, in screens.",
  },
};

// no-restricted-imports cannot carry the same `name` twice with different importNames in one list
// without merging; codes are resolved at report time from the message prefix, so merged entries are fine.
export function syntaxFor(scope, skip = []) {
  const parse = [{
    selector: "CallExpression[callee.name='parseFloat']",
    message: "parseFloat is banned: money is integer piastres (bigint), never floats (A2.4).",
  }];
  const mine = Object.entries(SYNTAX_RULES)
    .filter(([code, r]) => !skip.includes(code) && (r.scope === "all" || r.scope === scope || scope === "screens"))
    .map(([, r]) => ({ selector: r.selector, message: r.message }));
  return ["error", ...parse, ...mine];
}

export function importsFor(skip = []) {
  const paths = Object.entries(IMPORT_RULES)
    .filter(([code]) => !skip.includes(code))
    .map(([, r]) => r);
  return ["error", { paths }];
}

export function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return {};
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

/** Map an eslint message to a rule code (or null). */
export function codeOf(message) {
  const m = /\[(DS-[A-Z-]+)\]/.exec(message);
  if (!m) return null;
  if (m[1] !== "DS-MOTION") return m[1];
  return message.includes("reanimated") ? "DS-MOTION-REANIMATED" : "DS-MOTION-ANIMATED";
}

/** Eslint config blocks. `strict` disables baseline exemptions (used by check-debt). */
export function designConfig({ strict = false } = {}) {
  const blocks = [
    { files: GLOBS.all, ignores: GLOBS.allIgnores, rules: { "no-restricted-syntax": syntaxFor("all") } },
    {
      files: GLOBS.screens, ignores: GLOBS.allIgnores,
      rules: { "no-restricted-syntax": syntaxFor("screens"), "no-restricted-imports": importsFor() },
    },
  ];
  if (strict) return blocks;
  const base = loadBaseline();
  for (const [file, codes] of Object.entries(base)) {
    const skip = Object.keys(codes);
    const isScreen = /^apps\/mobile\/src\/(features|app)\//.test(file);
    const rules = { "no-restricted-syntax": syntaxFor(isScreen ? "screens" : "all", skip) };
    if (isScreen) rules["no-restricted-imports"] = importsFor(skip);
    blocks.push({ files: [file], rules });
  }
  return blocks;
}
