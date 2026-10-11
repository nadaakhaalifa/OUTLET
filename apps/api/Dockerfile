# syntax=docker/dockerfile:1
# Build context is the repository root: docker build -f apps/api/Dockerfile .
# NOT BUILT in the authoring environment (no docker available); first CI run is the first build.

FROM node:24-bookworm-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @outlet/api... \
 && pnpm --filter @outlet/api build
# Production-only node_modules (no dev deps, so no swc/vitest/typescript).
RUN pnpm --filter @outlet/api --prod deploy --legacy /out \
 && cp -r apps/api/dist /out/dist

FROM node:24-bookworm-slim AS runtime
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="outlet-api" \
      org.opencontainers.image.source="https://github.com/OWNER/OUTLET" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="UNLICENSED"
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
# Runs as the unprivileged built-in "node" user (uid 1000, numeric so Kubernetes runAsNonRoot can
# verify it); writes nothing to disk, so --read-only works.
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "dist/apps/api/src/main.js"]
