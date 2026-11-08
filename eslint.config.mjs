import js from "@eslint/js";
import tseslint from "typescript-eslint";
import districtRules from "./tooling/eslint-rules/index.mjs";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.turbo/**", "docs/**", "reports/**", "research_notes/**", "tooling/design/**", "*.cjs"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
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
    files: ["**/test/**/*.ts", "**/*.test.ts"],
    rules: { "@typescript-eslint/no-non-null-assertion": "off" },
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
