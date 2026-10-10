// Flat ESLint config for the whole monorepo (spec A2.1, A2.13, A2.15 neighbours).
// Owned by the devops task. Rules here are the non-negotiables from CLAUDE.md:
// no `any`, no ts-ignore, no non-null assertion outside tests, domain code pure.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

const TEST_FILES = ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx", "**/test/**", "**/__tests__/**"];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.expo/**",
      "**/.turbo/**",
      "**/coverage/**",
      "**/reports/**",
      "**/.stryker-tmp*/**",
      "**/*.d.ts",
      "infra/terraform/**/.terraform/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          "ts-ignore": true,
          "ts-nocheck": true,
          "ts-check": false,
          "ts-expect-error": "allow-with-description",
          minimumDescriptionLength: 10,
        },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // Money is bigint minor units; Number() on money hides precision loss (spec A2.4).
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: "parseFloat is banned: money is integer piastres (bigint), never floats (A2.4).",
        },
      ],
    },
  },
  {
    // Tests may use non-null assertions (A2.1 says "outside tests").
    files: TEST_FILES,
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },
  {
    // Domain layer purity (A2.3, rules.3 of the workflow): no clock, no randomness, no I/O.
    // Inject them through ports instead.
    files: ["packages/domain/src/**/*.ts", "apps/api/src/modules/*/domain/**/*.ts"],
    ignores: TEST_FILES,
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Date", property: "now", message: "Domain code is pure: inject a Clock port." },
        { object: "Math", property: "random", message: "Domain code is pure: inject a randomness port." },
        { object: "crypto", property: "randomUUID", message: "Domain code is pure: inject an id generator port." },
        { object: "crypto", property: "getRandomValues", message: "Domain code is pure: inject a randomness port." },
        { object: "process", property: "env", message: "Domain code must not read the environment." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Domain code performs no I/O." },
        { name: "setTimeout", message: "Domain code is pure: no timers." },
        { name: "setInterval", message: "Domain code is pure: no timers." },
        { name: "process", message: "Domain code must not touch the process." },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message: "parseFloat is banned: money is integer piastres (bigint), never floats (A2.4).",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "new Date() reads the clock: inject a Clock port.",
        },
      ],
    },
  },
  {
    // Plain JS/MJS tooling files: Node globals are fine, no TS rules.
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        Buffer: "readonly",
        structuredClone: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        fetch: "readonly",
        __dirname: "readonly",
        module: "readonly",
        require: "readonly",
      },
    },
    rules: { "no-console": "off" },
  },
  {
    // Metro only loads CommonJS config files, so require() is unavoidable here.
    files: ["**/metro.config.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
