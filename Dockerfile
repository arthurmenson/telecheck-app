# Telecheck app — Node 22 Debian/glibc build for native local ONNX inference.
# Same image serves staging (infra/staging/docker-compose.yml) and, at
# pre-go-live, the AWS deployment (F4_DEPLOY_RUNBOOK) — container parity is
# the point: what we test on the staging VPS is byte-identical to what
# ships to ECS/EC2 later.

FROM node:22-bookworm-slim AS build
WORKDIR /app
# CPU binaries are bundled; skip optional CUDA downloads.
ENV ONNXRUNTIME_NODE_INSTALL=skip
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY assets/*.txt ./assets/
COPY scripts/setup-ner-model.mjs ./scripts/setup-ner-model.mjs
RUN npm run ner:setup
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
# CPU binaries are bundled; skip optional CUDA downloads.
ENV ONNXRUNTIME_NODE_INSTALL=skip
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/assets ./assets
# Migrations ship in the image so the deploy step can apply them from the
# app container (psql client included below).
COPY migrations ./migrations
COPY scripts ./scripts
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a-w /app/assets
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
