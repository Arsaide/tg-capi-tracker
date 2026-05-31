# Architecture

This server is a pure HTTP attribution API. It no longer runs a Telegram bot itself —
the welcome bot (Python, `other-bots/welcome_bot.py`) lives outside and calls back into
the `/track/bot/*` endpoints. There is no channel, no invite pool, and no `chat_member`
handling anymore.

## Funnel and events

Only two events. The site stage is **PageView** (browser pixel — the server fires nothing
on `/track/click`). The conversion is **Lead**, fired server-side when the user enters the
funnel through the welcome bot (the button press).

```
FB Ad ──► landing ──► [button] ──► t.me/<welcome_bot>?start=<clickId> ──► welcome bot
              │                                                              │
              ▼                                                    user taps "🚀 ЗАПУСТИТЬ ИИ-ТЕРМИНАЛ"
        PageView (pixel)                                                     │
        (browser only)                                                       ▼
                                                                    POST /track/bot/activate
                                                                   ┌──────── Lead ────────┐
                                                                   │      server-side      │
                                                                   │  /track/bot/activate  │
                                                                   └───────────────────────┘
```

| Stage      | Source                                   | CAPI event | `event_id`       |
| ---------- | ---------------------------------------- | ---------- | ---------------- |
| Site       | landing (browser pixel)                  | `PageView` | (pixel-generated)|
| Conversion | welcome bot (`POST /track/bot/activate`) | `Lead`     | `lead_<clickId>` |

`POST /track/click` itself sends no CAPI event — it only persists the click context and
hands back the deep link.

## Why the `start` payload is the attribution key

Telegram does not deliver any landing-supplied payload on a channel join, which is why
the previous design needed single-use `member_limit: 1` invite links. The bot deep link
solves it directly: `https://t.me/<bot>?start=<payload>` hands the bot an arbitrary
token on `/start`. The token charset is `A-Za-z0-9_-`, max 64 chars — a `clickId`
(36-char UUID) fits, so **the clickId IS the start payload**. No invite pool, no
link↔click mapping, no `chat_member` matching.

Flow:

1. `POST /track/click` stores the click context and returns
   `https://t.me/<WELCOME_BOT_USERNAME>?start=<clickId>`. No CAPI event (PageView is the
   browser pixel).
2. User opens the welcome bot → `/start <clickId>` → the bot calls `POST /track/bot/start`
   `{clickId, tgUserId}` → we write `tg:{userId} → clickId`.
3. User taps **🚀 ЗАПУСТИТЬ ИИ-ТЕРМИНАЛ** → the bot calls `POST /track/bot/activate`
   `{clickId, tgUserId}` → we fire `Lead` with the click's `fbc/fbp/IP/UA` plus
   `external_id` (the hashed Telegram user id). The bot then reveals a URL button into
   the main trading bot.

The `/track/bot/*` endpoints are server-to-server and guarded by `AdminGuard`
(Bearer `ADMIN_TOKEN`) — the welcome bot sends it as `Authorization: Bearer <token>`.

## Data flow

### Redis (hot path, TTL = 30 days)

| Key            | Value                                         | Writer                                              | Reader                                         |
| -------------- | --------------------------------------------- | --------------------------------------------------- | ---------------------------------------------- |
| `click:{uuid}` | `ClickContext` (fbclid, fbc, fbp, ip, ua, ts) | `TrackingService.createClick` (`POST /track/click`) | `getClick` / `getClickByUser`                  |
| `tg:{userId}`  | `clickId` (uuid)                              | `TrackingService.linkUser` (`/track/bot/start` or `/activate`) | follow-up events (`Purchase`, `CompleteRegistration`) |

The `clickId` travels through the deep link itself, so there is no Redis key mapping a
link back to a click — the client already holds it.

### Postgres (config source of truth)

Single table:

```sql
Setting (key TEXT PRIMARY KEY, value TEXT, updatedAt TIMESTAMP)
```

Written only from `/admin/settings` via `SettingsService.setMany` inside a single `$transaction`.

## Settings cascade

`SettingsService.get(key)` walks three steps and returns the first non-empty hit:

1. **Postgres** — `Setting` row set through `/admin`.
2. **`.env`** — bootstrap and infrastructure keys (`DATABASE_URL`, `REDIS_URL`, `ADMIN_TOKEN`).
3. **Schema default** (`SETTINGS[]` in `settings.service.ts`) — e.g. `v21.0` for `FB_API_VERSION`.

`getRequired(key)` throws when nothing resolves. All app settings are **hot** — re-read on
every call site, so `/admin` edits take effect on the next request (there is no longer any
restart-bound setting now that the in-process bot is gone).

## Modules

| Module      | Responsibility                                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracking/` | `POST /track/click` (persist context, build the welcome-bot deep link — no CAPI), and the guarded `POST /track/bot/start` (`linkUser`, no event) / `POST /track/bot/activate` (`linkUser` + fire `Lead`) the welcome bot calls. |
| `capi/`     | `CapiService.send(ConversionEvent)`. Builds `fbc` from `fbclid + ts` when the cookie was not captured; a real `_fbc` always wins. `fbc/fbp/IP/UA` are **not** hashed; `external_id` is SHA-256 of the trimmed-lowercased value. |
| `settings/` | `SettingsService` + `/admin` (HTML UI + JSON API under `AdminGuard`).                                                                                                                                                          |
| `redis/`    | `@Global` ioredis client exported under the `REDIS` token.                                                                                                                                                                     |
| `prisma/`   | `@Global` `PrismaService extends PrismaClient`. `onModuleInit` connects, `onModuleDestroy` disconnects.                                                                                                                        |

## Non-obvious invariants

1. **`app.set('trust proxy', true)`** in `main.ts`. CAPI match quality depends on the client IP — behind nginx/cloudflare without `trust proxy` the Graph API would receive the server's IP, not the user's.
2. **`strictNullChecks: false`** in `tsconfig.json`. The compiler will not catch `null`/`undefined` in request bodies or Redis return values — handle them explicitly (the `/track/bot/*` handlers null-check `clickId`/`tgUserId` and the resolved click).
3. **The deep-link payload must stay within `[A-Za-z0-9_-]`, ≤64 chars.** The clickId (UUID) satisfies this. If you ever change the clickId format, keep it inside that charset or Telegram will reject the `/start` payload.
4. **`WELCOME_BOT_USERNAME` is required** — `/track/click` calls `getRequired` on it to build the deep link, so an unset value makes the endpoint throw. Store it without the leading `@` (a leading `@` is stripped defensively).

## Adding deeper conversion events

The `tg:{userId} → clickId` mapping (written at `/track/bot/start` and `/track/bot/activate`)
is the integration point. When a downstream bot knows the Telegram `user_id` — e.g. the main
trading bot confirms a deposit — it can `POST` an event that resolves the click via
`TrackingService.getClickByUser(userId)` and fires `CapiService.send` with the appropriate
`eventName` and a stable `eventId` (`<event>_<clickId>`). This is how `CompleteRegistration`
(trader-id entered) and `Purchase` (deposit confirmed) would attach to the original ad click
without forwarding the clickId all the way into the main bot.
