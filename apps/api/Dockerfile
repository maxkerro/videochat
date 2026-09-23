# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/api/Dockerfile -t videochat-api .

ARG NODE_VERSION=22.22-alpine

FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

# ---- build: install workspace deps, compile shared + api, prune to production deps ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter @videochat/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @videochat/shared build && pnpm --filter @videochat/api build
# Self-contained folder with only production dependencies (workspace packages copied in).
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @videochat/api deploy --prod --legacy --ignore-scripts /out

# ---- runtime: small image, non-root user ----
FROM node:${NODE_VERSION} AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out/package.json ./
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/dist ./dist
COPY --from=build --chown=node:node /out/drizzle ./drizzle
COPY --chown=node:node apps/api/docker-entrypoint.sh ./docker-entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1
ENTRYPOINT ["sh", "./docker-entrypoint.sh"]
