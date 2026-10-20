# pnpm-lock.yaml review, 2026-10-16

Read-only review. Method: `git show HEAD:pnpm-lock.yaml` (HEAD = 23f9ac6) parsed with the repo's own `yaml` package and compared to the working copy (11,998 lines) using a throwaway script in /tmp. No pnpm command was run.

## Headline

Keep the working lockfile. It is internally consistent: every importer's specifiers match its package.json (the only apparent mismatches are 8 `*` entries in packages/ui-native, which are autoInstallPeers copies of its peerDependencies). The diff against HEAD (+3368/-494) is mostly cumulative catch-up from uncommitted package.json changes made since 10 Oct, not a surprise upgrade. There are no integrity changes, no git/file/tarball dependencies and no unusual registries. Red flags are limited to one unresolved placeholder in pnpm-workspace.yaml and a few things to check before committing (below).

## 1. What changed

### Bounding the 14:48 run (confidence: moderate on "small", low on exact attribution)
- node_modules/.pnpm/lock.yaml (14:49) is byte-identical to pnpm-lock.yaml (14:48). So the working lockfile equals the installed state, but that cannot separate today's rewrite from earlier edits. No pnpm-lock.yaml.* backup exists.
- Evidence the 14:48 run did little to node_modules: the only entries touched at 14:48 are hoist symlinks in node_modules/.pnpm/node_modules for `vite`, `vitest`, `@vitest/mocker` (re-link to the same 3.2.7/7.3.7 versions; these are the "3 packages"). Nothing new was unpacked at 14:48.
- The 41 package directories added to node_modules/.pnpm were created at 14:09:21, not 14:48. They are exactly the echarts 6.1.0 / recharts 3.10.1 tree (d3-*, @types/d3-*, redux, @reduxjs/toolkit, immer, es-toolkit, victory-vendor, zrender, etc.). That was the builder's earlier install for admin-web. Per-workspace node_modules mtimes show api/mobile/ui-native/seller-web installs on 10-11, shopper-web 10-12, admin-web 14:09 today, ui-web 14:12 today. So most of the diff was installed earlier and the lockfile was simply stale versus package.json at HEAD.
- Conclusion: the 14:48 run most likely only re-wrote the lockfile to match the already-modified package.json files (plus the builder's hand edits) and re-hoisted vitest. I cannot prove the pre-14:48 working copy differed; if the owner has an editor or Time Machine copy from before 14:48, diff against it.

### Importers (18 at HEAD, 21 now)
- Added: apps/shopper-web, packages/api-client, packages/ui-web.
- Root devDependencies added: @axe-core/playwright ^4.13.0, @playwright/test ^1.64.0, sharp ^0.35.5.
- apps/admin-web: added @outlet/ui-web; devDependencies echarts 6.1.0, recharts 3.10.1 (matches package.json devDependencies).
- apps/seller-web: added @outlet/ui-web.
- apps/api added (dependencies): @aws-sdk/client-kms, client-s3, client-secrets-manager, s3-request-presigner (all 3.1149.0); @opentelemetry/api 1.9.1, exporter-metrics-otlp-http 0.223.0, exporter-trace-otlp-http 0.223.0, resources 2.12.0, sdk-metrics 2.12.0, sdk-node 0.223.0, semantic-conventions 1.43.0; @simplewebauthn/server 14.0.3; ioredis 6.0.0; jose 6.2.12. devDependencies: aws-sdk-client-mock 4.1.0, ioredis-mock 8.13.1.
- apps/mobile: removed @outlet/analytics and @outlet/auth-core; added @outlet/api-client, @expo-google-fonts/ibm-plex-sans-arabic 0.4.2, @expo/vector-icons 15.1.1, @shopify/flash-list 2.0.2, expo-blur 57.0.3, expo-camera 57.0.6, expo-document-picker 57.0.3, expo-font 57.0.4, expo-haptics 57.0.3, expo-image 57.0.5, expo-image-picker 57.0.20, expo-linear-gradient 57.0.2, react-native-gesture-handler 2.32.0, react-native-reanimated 4.5.1, react-native-svg 15.15.4, react-native-worklets 0.10.1.
- packages/ui-native: now records its peers as importer entries (autoInstallPeers): expo-blur, expo-haptics, expo-image, expo-linear-gradient, reanimated, gesture-handler, safe-area-context, @expo/vector-icons, all resolving to the same versions as mobile.
- No version change to any pre-existing direct dependency of any importer (no `~` rows in the importer comparison other than the additions above).

### Packages (1103 -> 1290 entries)
- Real additions: 199 new package names (~187 net entries). Families: @aws-sdk/@smithy (api), @opentelemetry/* plus @grpc/grpc-js, @grpc/proto-loader, protobufjs 7.6.6 (sdk-node), @peculiar/*, asn1js, @levischuck/tiny-cbor, @hexagon/base64 (simplewebauthn), ioredis/denque/redis-errors, ioredis-mock, sinon/nise/@sinonjs (aws-sdk-client-mock), playwright 1.64.0/playwright-core/@playwright/test/axe-core, expo-* native modules, expo-image-loader, react-native-svg, @shopify/flash-list, @expo/vector-icons, css-tree/css-select/boolbase/domhandler/entities 4.5.0 (svg), barcode-detector/zxing-wasm (expo-camera), echarts/zrender/recharts and the d3/redux tree.
- Real removals: flow-estree 0.331.0, flow-parser 0.331.0 (no longer pulled in).
- Real version changes (28 names, all direction is toward consistency):
  - Metro stack: the extra 0.87.1 line is gone. HEAD had metro*, @react-native/babel-preset, codegen, metro-config at 0.87.1 next to 0.84.x and RN 0.86.3; now only metro 0.84.5/0.84.6 and @react-native/* 0.86.3 remain. This is a fix (HEAD had a mismatched Metro/RN pairing).
  - react-native-reanimated 4.7.1 -> 4.5.1, react-native-worklets 0.13.0 -> 0.10.1, react-native-gesture-handler 3.3.0 -> 2.32.0 (downgrades to the SDK 57 bundled versions; HEAD had them only as transitive/peer resolutions).
  - Added second copies: tslib (1.14.1, 2.3.0 for echarts, 2.8.1), react-is 16.13.1 (hoist-non-react-statics via react-redux), type-fest 5.10.0, es-module-lexer 3.0.3 alongside 1.7.0.
- Orphaned on disk only: node_modules/.pnpm still holds metro@0.87.1, reanimated@4.7.1, gesture-handler@3.3.0 directories from before; they are not in the lockfile and would be pruned by the next clean install.

### Churn that is ordering or peer-hash only
- Importer rows with only a peer-dependency suffix change (same version): admin-web `next`; seller-web `next`; mobile expo, expo-constants, expo-linking, expo-router, expo-status-bar, expo-updates, react-i18next, react-native, react-native-safe-area-context, react-native-screens; ui-native `react-native` (dev). These come from new peers in the graph (e.g. react-native-svg, reanimated) altering the `(...)` suffix. No version moved.
- The remaining bulk of the 3,862 changed lines is new snapshot/package blocks (additions) and re-sorted snapshot suffixes for the packages above. Snapshots grew 1111 -> 1389.

## 2. Expo Go (SDK 57) compatibility
Compared the lockfile mobile importer with apps/mobile/node_modules/expo/bundledNativeModules.json (expo 57.0.27). All 27 native-bearing or Expo-governed entries are inside the bundled ranges or equal:

- Exact matches: react 19.2.3, react-native 0.86.3, @shopify/flash-list 2.0.2, react-native-reanimated 4.5.1, react-native-worklets 0.10.1, react-native-svg 15.15.4.
- Within tilde/caret ranges: every expo-* package (blur 57.0.3, camera 57.0.6, constants 57.0.21, document-picker 57.0.3, font 57.0.4, haptics 57.0.3, image 57.0.5, image-picker 57.0.20, linear-gradient 57.0.2, linking 57.0.12, localization 57.0.2, router 57.0.25, secure-store 57.0.4, status-bar 57.0.1, updates 57.0.25), react-native-gesture-handler 2.32.0 (~2.32.0), safe-area-context 5.7.0 (~5.7.0), react-native-screens 4.26.2 (bundled ~4.26.0), @expo/vector-icons 15.1.1 (bundled ^15.0.2).
- Not in the bundled list (JS-only, no native code): @expo-google-fonts/ibm-plex-sans-arabic 0.4.2; expo itself.
- Mismatches: none. Note expo-updates and expo-camera and expo-image-picker are native; they match, but expo-updates is inert in Expo Go.
- Out of scope for the lockfile but worth knowing: `expo-doctor` / `expo install --check` would confirm; I did not run them.

## 3. Security and supply chain
- Integrity: for every package key present in both HEAD and working lockfile, the `resolution` object is identical. Zero integrity changes.
- Resolution types: every one of the 1290 packages has an sha512 integrity and a plain registry resolution. No `tarball:`, git, github or file entries in packages (workspace deps are `link:` only). No .npmrc, so default registry.
- Deprecated: no newly added deprecated packages (2 pre-existing deprecated entries retained).
- Install scripts: the v9 lockfile format does not record `requiresBuild`, so I inspected package.json of the new packages in node_modules:
  - protobufjs 7.6.6 has `postinstall: node scripts/postinstall` (new, pulled by @opentelemetry sdk-node via @grpc/proto-loader). RED FLAG (process): pnpm-workspace.yaml (uncommitted, +1 line) now contains `protobufjs: set this to true or false`, a pnpm-generated placeholder that is neither true nor false. The owner must choose. Recommended: `false` (protobufjs's postinstall only does optional CLI dependency setup and the runtime works without it).
  - sharp 0.35.5 declares an `install` script; it ships platform binaries through optional @img/sharp-* packages (darwin-arm64 present). It is not in allowBuilds; decide whether it must run (usually unnecessary with prebuilt @img packages). sharp was added to the root devDependencies for asset tooling.
  - @swc/core and esbuild have pre-existing allowBuilds true entries (unchanged).
  - playwright has no install script (browsers are downloaded separately by `playwright install`).
- The 3 "added" packages: not new code. They are re-hoisted symlinks for vite 7.3.7, vitest 3.2.7 and @vitest/mocker 3.2.7 in node_modules/.pnpm/node_modules (14:48:57). Versions identical to HEAD. Two peer variants exist (@types/node 24.19.1 and 26.6.4), which pre-existed.
- Supply-chain scale: the api importer pulls roughly 140 new transitive packages (aws-sdk/smithy, opentelemetry, grpc). Those are well-known publishers, but this is a large new surface; ensure it is intentional.

## 4. Duplicates and singletons
- react 19.2.3, react-dom 19.2.3, react-native 0.86.3, typescript 6.0.3, @types/react 19.2.18, expo 57.0.27, i18next 26.4.2, react-i18next 17.0.16, scheduler 0.27.0, reanimated 4.5.1, worklets 0.10.1: single version each. No react or react-native duplicates (recharts resolves react 19.2.3 and react-dom 19.2.3).
- zod: 3.25.76 and 4.6.5 both present (same as HEAD). Confirm which workspace packages still use 3.x (likely a transitive such as an SDK); a schema object created by one major must not be passed to the other.
- react-is: 16.13.1, 18.3.1, 19.3.0 (16.x new, from hoist-non-react-statics under react-redux/recharts). Harmless in practice, admin-web only.
- tslib: 1.14.1, 2.3.0 (echarts pinned exactly), 2.8.1. Harmless.
- @babel/core appears in several peer-suffix variants (7.2x and 8.0) for reanimated/gesture-handler/metro; this pre-existed and inflates snapshot count but is not a runtime singleton issue for the app.

## 5. Recommendation
Keep the working lockfile (no restore, no clean regenerate). Regenerating would risk re-floating `^` ranges (aws-sdk, opentelemetry) with no benefit, and restoring HEAD would be out of sync with package.json on 18+ changed manifests (`pnpm install --frozen-lockfile` would fail in CI).

Before committing, the owner should:
1. Resolve `protobufjs: set this to true or false` in pnpm-workspace.yaml (and decide sharp). Do not commit the placeholder.
2. Verify the lockfile matches the manifests without changing anything: `pnpm install --frozen-lockfile --lockfile-only` is NOT read-only in all versions; the safest check is `pnpm install --frozen-lockfile` in a scratch clone (`git stash`-free: `git worktree add ../outlet-lockcheck` then copy the working package.json files and lockfile there).
3. Run in that scratch clone or after commit: `pnpm -r typecheck`, `pnpm -r test`, `pnpm depcruise`, and `pnpm --filter @outlet/mobile exec npx expo-doctor` (plus `npx expo install --check` in apps/mobile).
4. Confirm the recharts and echarts devDependency placement is intended for admin-web: a Next.js app that imports them at runtime and is deployed with `pnpm install --prod` would omit them. If admin-web is built before pruning this is fine; otherwise move them to dependencies (and fix the 4 lock hunks the same way).
5. Review the commit as three pieces if wanted: manifests (package.json files, workspace yaml), lockfile, then code. Spot-check that no workspace package.json still references removed deps (@outlet/analytics, @outlet/auth-core in mobile were removed intentionally?).
6. Optionally run `pnpm audit` and `pnpm why zod` to review the two zod majors and the new aws-sdk/otel surface.
7. If a clean state is desired later, the owner can run `rm -rf node_modules && pnpm install --frozen-lockfile` (drops the orphaned metro 0.87.1, reanimated 4.7.1 and gesture-handler 3.3.0 directories).
