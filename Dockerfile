# syntax=docker/dockerfile:1.7

# ===== Stage 1: build =====
FROM node:22-alpine AS builder
WORKDIR /app

# Prisma engines on alpine require openssl
RUN apk add --no-cache openssl

# Install dependencies first (separately from source) for better layer cache.
# postinstall runs `prisma generate` and needs the schema, so copy prisma/ early.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# Build the Nest app
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ===== Stage 2: runner =====
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl

# Copy installed deps (with generated Prisma client) and built artifacts from builder.
# We keep all deps including prisma CLI so the entrypoint can run migrate deploy.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

EXPOSE 3000

# `prisma migrate deploy` is idempotent — safe to run on every container start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
