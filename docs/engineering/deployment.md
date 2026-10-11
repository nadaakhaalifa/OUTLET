# API deployment artifact

## Build choice
- esbuild bundle: one file, fast, but esbuild is not linked in this workspace (needs install) and bundling Nest breaks lazy `require` and decorator metadata unless plugged.
- swc transpile + node_modules (chosen): `@swc/core` is already a devDependency, supports `decoratorMetadata`, and keeps one output file per source file, so stack traces and Nest DI metadata stay faithful.
- Output is CommonJS because the source uses extensionless relative imports that Node ESM cannot resolve; `@outlet/*` workspace imports are rewritten to relative paths via `jsc.paths`.

## Commands
- `cd apps/api && node build/build.mjs` (or `pnpm --filter @outlet/api build`) writes `apps/api/dist/{apps/api,packages/*}/src/**` (tests excluded, JSON copied).
- `pnpm --filter @outlet/api start` runs `node dist/apps/api/src/main.js`. Third-party deps resolve from `node_modules`.
- Local dev boot: `PORT=3917 DEV_FIXTURES=true node dist/apps/api/src/main.js`; routes carry the `/v1` prefix (`/v1/health`, `/v1/ready`).

## Container
`apps/api/Dockerfile` (context = repo root): build stage installs and builds, `pnpm deploy --prod` produces production-only node_modules, runtime stage is node:24-bookworm-slim, user `node`, no writes to disk (`--read-only` safe), HEALTHCHECK on `/v1/health`, OCI labels. It has NOT been built: docker is not installed where it was authored. `pnpm deploy --legacy` and the lockfile filter are unverified until the first CI build.

## Status
The image boots only with `DEV_FIXTURES=true`; production mode refuses to start. See `docs/plan/production-boot-gap.md`.
