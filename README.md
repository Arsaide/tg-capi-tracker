# tg-capi-tracker

NestJS HTTP API that attributes a Telegram-bot funnel to Facebook Ad clicks and forwards it to Meta via the **Conversion API (CAPI)**.

Funnel: **FB Ad → landing → welcome bot**
Events: `PageView` (browser pixel, on the site) → `Lead` (server, `/track/bot/activate`, when the user enters via the welcome bot)

`/track/click` returns a welcome-bot deep link `https://t.me/<bot>?start=<clickId>` — the `clickId` rides as the bot's `/start` payload, so attribution needs no invite links or `chat_member` matching. `/track/click` fires no CAPI event. When the user presses **🚀 ЗАПУСТИТЬ ИИ-ТЕРМИНАЛ** in the (external Python) welcome bot, the bot calls back into `/track/bot/activate` and `Lead` fires server-side. The server runs no Telegram bot of its own.

## Quick start (Docker)

```bash
cp .env.example .env             # set ADMIN_TOKEN and WELCOME_BOT_USERNAME
docker compose up -d --build     # postgres + redis + app; migrations apply automatically
open http://localhost:3000/admin # paste ADMIN_TOKEN, fill WELCOME_BOT_USERNAME / FB_*
```

Minimum `.env`:

- `ADMIN_TOKEN` — bearer for `/admin` **and** for the server-to-server `/track/bot/*` calls the welcome bot makes. Generate with `openssl rand -hex 32`.
- `WELCOME_BOT_USERNAME` — `@username` (without `@`) of the welcome bot the landing links into.

Everything else (`FB_PIXEL_ID`, `FB_CAPI_TOKEN`, `LANDING_URL`) is configured at runtime via `/admin` — see [`docs/admin-ui.md`](docs/admin-ui.md). The welcome bot itself lives in [`other-bots/welcome_bot.py`](other-bots/welcome_bot.py) and is configured via `TRACKER_API_URL` + `TRACKER_API_TOKEN` (= `ADMIN_TOKEN`).

## Local development

```bash
docker compose up -d postgres redis    # dependencies only
bun install                            # postinstall = prisma generate
bun run db:migrate                     # apply migrations
bun run start:dev                      # nest start --watch on :3000
```

Tests, lint, format:

```bash
bun run test           # jest, ~59 specs
bun run test:cov       # with coverage
bun run lint           # eslint over src/**/*.ts
bun run format         # prettier --write
```

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — modules, data flow, non-obvious invariants.
- [`docs/admin-ui.md`](docs/admin-ui.md) — settings reference, source cascade, edge cases.
- [`docs/landing-integration.md`](docs/landing-integration.md) — HTML/JS snippet, `/track/click` contract, pixel dedup.

## Stack

| Layer    | Tech                                   | Role                                          |
| -------- | -------------------------------------- | --------------------------------------------- |
| HTTP     | NestJS 11 + Express                    | `/track/click`, `/track/bot/*`, `/admin/*`    |
| CAPI     | axios → Graph API                      | server-side `Lead`                            |
| Hot path | Redis 7                                | `click:*`, `tg:*` (TTL 30 days)               |
| Config   | Postgres 16 + Prisma 6                 | `Setting` table, source of truth for `/admin` |
| Bot      | Python aiogram (`other-bots/`)         | external welcome bot, calls `/track/bot/*`    |
| Tests    | Jest + ioredis-mock + in-memory Prisma | no network deps                               |
