import js from "@eslint/js";
import tseslint from "typescript-eslint";
import districtRules from "./tooling/eslint-rules/index.mjs";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/.next/**", "**/.cache/**", "**/node_modules/**", "**/.turbo/**", "**/.stryker-tmp/**", "docs/**", "reports/**", "research_notes/**", "tooling/design/**", "*.cjs"] },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { district: districtRules },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/ban-ts-comment": "error",
      "district/no-float-money": "error",
    },
  },
  {
    // Tests may use non-null assertions; everything else stays strict.
    files: ["**/test/**/*.ts", "**/test/**/*.tsx", "**/*.test.ts", "**/*.test.tsx"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
  },
  {
    // User-facing strings must come from the i18n catalogs (AR required).
    files: ["packages/ui-web/src/**/*.tsx", "apps/**/src/**/*.tsx"],
    ignores: ["**/*.test.tsx", "**/examples/**"],
    plugins: { district: districtRules },
    rules: { "district/no-hardcoded-ui-strings": "error" },
  },
  {
    // Bigint arithmetic is implemented here; the rule guards every other caller.
    files: ["packages/money/src/**/*.ts"],
    rules: { "district/no-float-money": "off" },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
);
