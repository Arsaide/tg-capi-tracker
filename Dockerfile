FROM oven/bun:1.3.13-alpine AS builder
WORKDIR /app

RUN apk add --no-cache openssl

COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3.13-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/dist ./dist

EXPOSE 3000

CMD ["sh", "-c", "bunx prisma migrate deploy && bun dist/main.js"]
