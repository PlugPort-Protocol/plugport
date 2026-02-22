# Multi-stage build for PlugPort server
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy workspace config
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* ./
COPY tsconfig.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/

# Install dependencies
RUN pnpm install --frozen-lockfile || pnpm install

# Copy source code
COPY packages/shared/ packages/shared/
COPY packages/server/ packages/server/

# Build
RUN pnpm --filter @plugport/shared build
RUN pnpm --filter @plugport/server build

# ---- Production image ----
FROM node:22-alpine AS runner

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Copy built artifacts
COPY --from=builder /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/server/package.json packages/server/
COPY --from=builder /app/packages/server/dist/ packages/server/dist/
COPY --from=builder /app/node_modules/ node_modules/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=builder /app/packages/server/node_modules/ packages/server/node_modules/

# Environment
ENV NODE_ENV=production
ENV HTTP_PORT=8080
ENV WIRE_PORT=27017

EXPOSE 8080 27017

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

CMD ["node", "packages/server/dist/index.js"]
