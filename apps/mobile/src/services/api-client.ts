/**
 * The single place the mobile app imports the generated client from. Until `pnpm install` links the
 * workspace package `@outlet/api-client`, the source is reached by a relative path (the same pattern
 * workspace.ts uses for the other packages). After linking, replace this path with "@outlet/api-client".
 */
export * from "@outlet/api-client";
