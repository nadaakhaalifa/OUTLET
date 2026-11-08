// Architecture fitness functions (master prompt A2.3). Run: pnpm depcruise
const INFRA_PACKAGES =
  "^(pg|pg-.*|postgres|kysely|@prisma/.*|prisma|ioredis|redis|bullmq|amqplib|kafkajs|@aws-sdk/.*|aws-sdk|" +
  "axios|undici|node-fetch|got|express|fastify|hono|@nestjs/.*|react|react-dom|react-native|expo|expo-.*|" +
  "@sentry/.*|@opentelemetry/.*)$";
const IO_CORE_MODULES =
  "^(node:)?(fs|fs/promises|net|http|https|http2|dgram|dns|tls|child_process|cluster|worker_threads|os|readline|stream|zlib|vm|perf_hooks|crypto)$";
const TEST_PATH = "(^|/)(test|tests|__tests__)/|\\.(test|spec)\\.(ts|tsx|mjs)$";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-deep-import-into-package",
      severity: "error",
      comment: "Cross-package imports go only through the package's public src/index.ts (A2.3).",
      from: { path: "^(?:packages|apps)/([^/]+)/" },
      to: {
        path: "^packages/([^/]+)/",
        pathNot: ["^packages/$1/", "^packages/[^/]+/src/index\\.ts$", "^packages/[^/]+/package\\.json$"],
      },
    },
    {
      name: "no-deep-import-into-app-module",
      severity: "error",
      comment: "App modules are bounded contexts; other modules import only <module>/index.ts.",
      from: { path: "^apps/([^/]+)/src/modules/([^/]+)/" },
      to: {
        path: "^apps/$1/src/modules/([^/]+)/",
        pathNot: ["^apps/[^/]+/src/modules/$2/", "^apps/[^/]+/src/modules/[^/]+/index\\.ts$"],
      },
    },
    {
      name: "domain-no-infra-packages",
      severity: "error",
      comment: "domain/ is pure: no infrastructure packages.",
      from: { path: "(^|/)domain/", pathNot: TEST_PATH },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg", "npm-unknown"], path: INFRA_PACKAGES },
    },
    {
      name: "domain-no-io-core-modules",
      severity: "error",
      comment: "domain/ is pure: no Node I/O or ambient state.",
      from: { path: "(^|/)domain/", pathNot: TEST_PATH },
      to: { dependencyTypes: ["core"], path: IO_CORE_MODULES },
    },
    {
      name: "domain-no-outer-layers",
      severity: "error",
      comment: "Dependencies point inward: domain never imports application or adapters.",
      from: { path: "(^|/)domain/", pathNot: TEST_PATH },
      to: { path: "(^|/)(application|adapters|infra)/" },
    },
    {
      name: "application-no-adapters",
      severity: "error",
      comment: "Use cases depend on ports, never on adapters.",
      from: { path: "(^|/)application/", pathNot: TEST_PATH },
      to: { path: "(^|/)adapters/" },
    },
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "no-orphans",
      severity: "warn",
      from: { orphan: true, pathNot: ["(^|/)\\.[^/]+\\.(js|cjs|mjs|ts)$", "\\.d\\.ts$", "index\\.ts$", TEST_PATH] },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    includeOnly: "^(packages|apps|tooling)/",
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "require", "node", "default"] },
  },
};
