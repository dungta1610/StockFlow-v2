# Build context is the repo root (the API depends on workspace packages).
#   docker build -f apps/api/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@9.15.9

# Manifests first so dependency install is cached independently of source edits.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ai-harness/package.json packages/ai-harness/
RUN pnpm install --frozen-lockfile --filter @stockflow/api...

COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN pnpm --filter @stockflow/contracts build \
 && pnpm --filter @stockflow/api build \
 && pnpm --filter @stockflow/api deploy --prod /out

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    MIGRATIONS_DIR=/app/migrations
COPY --from=build /out ./
COPY db/migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
