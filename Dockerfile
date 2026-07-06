# Telecheck app — multi-stage build (Node 20 LTS per ADR-022 stack).
# Same image serves staging (infra/staging/docker-compose.yml) and, at
# pre-go-live, the AWS deployment (F4_DEPLOY_RUNBOOK) — container parity is
# the point: what we test on the staging VPS is byte-identical to what
# ships to ECS/EC2 later.

FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# Migrations ship in the image so the deploy step can apply them from the
# app container (psql client included below).
COPY migrations ./migrations
COPY scripts/apply-migrations.sh ./scripts/apply-migrations.sh
RUN apk add --no-cache postgresql16-client bash
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
