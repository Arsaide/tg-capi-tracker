# tg-capi-tracker

NestJS server that attributes Telegram-channel joins to Facebook Ad clicks and forwards the funnel to Meta via the **Conversion API (CAPI)**.

Funnel: **FB Ad → landing → Telegram channel**
Events: `PageView` (browser pixel) → `Lead` (server) → `Subscribe` (server)

Telegram channels don't carry an attributable payload on join, so every landing visitor is handed a **personal single-use invite link** (`member_limit: 1`). The resulting `chat_member` update matches 1:1 against the click that issued the link.

## Quick start (Docker)

```bash
cp .env.example .env             # set ADMIN_TOKEN and BOT_TOKEN
docker compose up -d --build     # postgres + redis + app; migrations apply automatically
open http://localhost:3000/admin # paste ADMIN_TOKEN, fill CHANNEL_ID / FB_*
```

Minimum `.env`:

- `ADMIN_TOKEN` — bearer for `/admin`. Generate with `openssl rand -hex 32`.
- `BOT_TOKEN` — token from `@BotFather`. The bot must be a channel admin with `can_invite_users`.

Everything else (`CHANNEL_ID`, `FB_PIXEL_ID`, `FB_CAPI_TOKEN`, pool sizing) is configured at runtime via `/admin` — see [`docs/admin-ui.md`](docs/admin-ui.md).

## Local development

```bash
docker compose up -d postgres redis    # dependencies only
bun install                            # postinstall = prisma generate
bun run db:migrate                     # apply migrations
bun run start:dev                      # nest start --watch on :3000
```

Tests, lint, format:

```bash
bun run test           # jest, ~84 specs
bun run test:cov       # with coverage
bun run lint           # eslint over src/**/*.ts
bun run format         # prettier --write
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — modules, data flow, non-obvious invariants.
- [`docs/admin-ui.md`](docs/admin-ui.md) — settings reference, source cascade, edge cases.
- [`docs/landing-integration.md`](docs/landing-integration.md) — HTML/JS snippet, `/track/click` contract, pixel dedup.

## Stack

| Layer    | Tech                                   | Role                                                        |
| -------- | -------------------------------------- | ----------------------------------------------------------- |
| HTTP     | NestJS 11 + Express                    | `/track/click`, `/admin/*`                                  |
| Telegram | nestjs-telegraf + Telegraf 4           | `chat_member` handler, invite-link creation                 |
| CAPI     | axios → Graph API                      | server-side `Lead` / `Subscribe`                            |
| Hot path | Redis 7                                | `click:*`, `link:*`, `tg:*` (TTL 30 days), invite-link pool |
| Config   | Postgres 16 + Prisma 6                 | `Setting` table, source of truth for `/admin`               |
| Tests    | Jest + ioredis-mock + in-memory Prisma | no network deps                                             |
