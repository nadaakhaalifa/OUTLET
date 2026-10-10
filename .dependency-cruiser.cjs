// Architecture fitness functions (master prompt A2.3, T11). Owned by the devops task.
// Run with: pnpm depcruise   (needs Node 22, 24 or >=26; the repo pins Node 24)
//
// Layout assumptions (see docs/engineering/architecture-fitness.md):
//   packages/<name>/src/index.ts          public entry of a shared package
//   apps/api/src/modules/<m>/{domain,application,adapters}/**   hexagonal modules (when they exist)
//   apps/api/src/modules/<m>/index.ts     public entry of an API module

/** Infrastructure and runtime-specific packages the pure domain must never import. */
const INFRA_PACKAGES =
  "^(pg|pg-.*|postgres|kysely|@prisma/.*|prisma|ioredis|redis|bullmq|amqplib|kafkajs|@aws-sdk/.*|aws-sdk|" +
  "@google-cloud/.*|@azure/.*|axios|undici|node-fetch|got|express|fastify|hono|@nestjs/.*|react|react-dom|" +
  "react-native|react-native-.*|expo|expo-.*|@sentry/.*|posthog-.*|@opentelemetry/.*)$";

/** Node core modules that perform I/O or read ambient state. */
const IO_CORE_MODULES =
  "^(node:)?(fs|fs/promises|net|http|https|http2|dgram|dns|tls|child_process|cluster|worker_threads|os|" +
  "readline|stream|zlib|vm|perf_hooks|crypto)$";

const TEST_PATH = "\\.(test|spec)\\.(ts|tsx|js|mjs)$|(^|/)(test|tests|__tests__|__mocks__)/";

const DOMAIN_SOURCES = "^(packages/domain/src|apps/api/src/modules/[^/]+/domain)/";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ---- A2.3: no cross-module imports except through a module's public index.ts ----
    {
      name: "no-deep-import-into-shared-package",
      severity: "error",
      comment:
        "A package or app may only import another package through its public src/index.ts (A2.3). " +
        "Deep imports bypass the module boundary.",
      from: { path: "^(?:packages|apps)/([^/]+)/" },
      to: {
        path: "^packages/([^/]+)/",
        pathNot: ["^packages/$1/", "^packages/[^/]+/src/index\\.ts$", "^packages/[^/]+/package\\.json$"],
      },
    },
    {
      name: "no-deep-import-into-api-module",
      severity: "error",
      comment: "API modules are bounded contexts. Other modules may import only <module>/index.ts (A2.3).",
      from: { path: "^apps/api/src/modules/([^/]+)/" },
      to: {
        path: "^apps/api/src/modules/([^/]+)/",
        pathNot: ["^apps/api/src/modules/$1/", "^apps/api/src/modules/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "no-api-module-deep-import-from-outside",
      severity: "error",
      comment: "Code outside apps/api/src/modules must also use a module's public index.ts only.",
      // Independent adversarial suites (adversarial.*.test.ts) probe module internals on purpose.
      from: { path: "^apps/api/src/", pathNot: ["^apps/api/src/modules/", "^apps/api/src/adversarial\\.[^/]+\\.test\\.ts$"] },
      to: { path: "^apps/api/src/modules/[^/]+/", pathNot: "^apps/api/src/modules/[^/]+/index\\.ts$" },
    },

    // ---- A2.3: layers run domain -> application -> adapters (dependencies point inward) ----
    {
      name: "domain-must-not-import-application-or-adapters",
      severity: "error",
      comment: "The domain layer is the innermost ring and may not depend on use cases or adapters.",
      from: { path: "^apps/api/src/modules/[^/]+/domain/" },
      to: { path: "^apps/api/src/modules/[^/]+/(application|adapters)/" },
    },
    {
      name: "application-must-not-import-adapters",
      severity: "error",
      comment: "Use cases depend on ports defined in the domain, never on adapters.",
      from: { path: "^apps/api/src/modules/[^/]+/application/" },
      to: { path: "^apps/api/src/modules/[^/]+/adapters/" },
    },

    // ---- A2.3: no infra imports in domain/ ----
    {
      name: "domain-no-infra-packages",
      severity: "error",
      comment: "Pure domain code may not import databases, HTTP clients, frameworks, SDKs or UI libraries.",
      from: { path: DOMAIN_SOURCES, pathNot: TEST_PATH },
      to: { path: INFRA_PACKAGES, dependencyTypesNot: ["core", "local"] },
    },
    {
      name: "domain-no-io-core-modules",
      severity: "error",
      comment: "Pure domain code performs no I/O and reads no ambient state (clock, randomness, fs, network).",
      from: { path: DOMAIN_SOURCES, pathNot: TEST_PATH },
      to: { dependencyTypes: ["core"], path: IO_CORE_MODULES },
    },
    {
      name: "domain-no-workspace-imports",
      severity: "error",
      comment:
        "packages/domain is the base of the dependency graph: it may not import any other workspace package or app.",
      from: { path: "^packages/domain/src/", pathNot: TEST_PATH },
      to: { path: "^(packages/(?!domain/)[^/]+|apps/[^/]+)/" },
    },
    {
      name: "packages-must-not-import-apps",
      severity: "error",
      comment: "Shared packages never depend on applications.",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "apps-must-not-import-each-other",
      severity: "error",
      comment: "Apps communicate through the API contract, not by importing each other.",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/([^/]+)/", pathNot: "^apps/$1/" },
    },
    {
      name: "mobile-must-not-import-server-packages",
      severity: "error",
      comment: "The mobile bundle must not pull in server-only packages (db, outbox, idempotency).",
      from: { path: "^apps/mobile/" },
      to: { path: "^packages/(db|outbox|idempotency)/" },
    },
    {
      name: "production-code-must-not-import-tests",
      severity: "error",
      comment: "Test helpers must not leak into production code.",
      from: { path: "^(packages|apps)/", pathNot: TEST_PATH },
      to: { path: TEST_PATH },
    },

    // ---- general hygiene (dependency-cruiser recommended subset) ----
    {
      name: "no-circular",
      severity: "error",
      comment: "Circular dependencies make modules impossible to reason about and to mutate-test.",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      severity: "error",
      comment: "Every import must resolve.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "not-to-deprecated-core",
      severity: "warn",
      comment: "Deprecated Node core module.",
      from: {},
      to: { dependencyTypes: ["deprecated"] },
    },
    {
      name: "not-to-dev-dep",
      severity: "error",
      comment:
        "Production code must not depend on a devDependency. A package that is both a peerDependency and a " +
        "devDependency (the usual way to develop a library against its peer) is allowed.",
      from: { path: "^(packages|apps)/[^/]+/src/", pathNot: TEST_PATH + "|\\.config\\." },
      to: { dependencyTypes: ["npm-dev"], dependencyTypesNot: ["type-only", "npm-peer"] },
    },
    {
      name: "no-non-package-json",
      severity: "error",
      comment: "Import of a package that is not declared in the importing package.json (relies on hoisting).",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment:
        "Module that nothing imports and that imports nothing. Entry files, tests, configs and type declarations are exempt.",
      from: {
        orphan: true,
        pathNot: [
          "(^|/)\\.[^/]+\\.(js|cjs|mjs|ts|json)$",
          "\\.d\\.ts$",
          "(^|/)stryker\\.config\\.mjs$",
          "^(packages|apps)/[^/]+/src/index\\.ts$", // public entry points
          "(^|/)tsconfig\\.json$",
          "(^|/)(babel|webpack|metro|vitest|vite|jest)\\.config\\.(js|cjs|mjs|ts)$",
          TEST_PATH,
          "^apps/mobile/src/app/", // Expo Router: files are routes, not imports.
        ],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: ["node_modules"] },
    exclude: {
      path: [
        "(^|/)(dist|build|coverage|reports|\\.expo|\\.turbo|\\.stryker-tmp)/",
        "^infra/",
        "^tooling/",
        "^docs/",
        "^\\.github/",
      ],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    moduleSystems: ["es6", "cjs"],
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["main", "types"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
