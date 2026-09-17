# Build context is the repo root.  docker build -f apps/web/Dockerfile .
FROM node:24-alpine AS build
WORKDIR /repo
RUN npm install -g pnpm@9.15.9
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/ai-harness/package.json packages/ai-harness/
RUN pnpm install --frozen-lockfile --filter @stockflow/web...
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN pnpm --filter @stockflow/web build

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
