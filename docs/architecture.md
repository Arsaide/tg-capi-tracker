# Architecture

## Funnel and events

```
FB Ad ──► landing ──► [Join button click] ──► personal invite link ──► channel join
              │                                                              │
              ▼                                                              ▼
        PageView (pixel)                                            chat_member update
              │                                                              │
              ▼                                                              ▼
        ┌──── Lead ────┐                                       ┌──── Subscribe ────┐
        │  server-side │                                       │    server-side     │
        │  POST /track │                                       │  chat_member       │
        │   /click     │                                       │  handler           │
        └──────────────┘                                       └────────────────────┘
```

| Stage      | Source                        | CAPI event  | `event_id` (pixel dedup) |
| ---------- | ----------------------------- | ----------- | ------------------------ |
| Click      | landing (`POST /track/click`) | `Lead`      | `lead_<clickId>`         |
| Conversion | `chat_member` handler         | `Subscribe` | `sub_<clickId>`          |

## Why single-use invite links

Telegram channels do not deliver any user-supplied payload on join — the `chat_member` update contains only the user and the `invite_link` they joined through. With a shared link there is no way to attribute the join to a specific click.

The workaround: every landing visitor gets their **own** link with `member_limit: 1`. When `chat_member` reports a `left|kicked → member|restricted` transition, we look up the `clickId` by `invite_link.invite_link` and emit `Subscribe` with the right `fbc/fbp/IP/UA`.

Side effect: joins via the channel's public link or manual admin-adds are **not attributed**. This is by design.

## Data flow

### Redis (hot path, TTL = 30 days)

| Key                  | Value                                         | Writer                                              | Reader                                                |
| -------------------- | --------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------- |
| `click:{uuid}`       | `ClickContext` (fbclid, fbc, fbp, ip, ua, ts) | `TrackingService.createClick` (`POST /track/click`) | `TrackingService.getByLink` / `getClickByUser`        |
| `link:{inviteLink}`  | `clickId` (uuid)                              | `TrackingService.bindLink` (`POST /track/click`)    | `TelegramUpdate.onChatMember`                         |
| `tg:{userId}`        | `clickId` (uuid)                              | `TelegramUpdate.onChatMember` (on join)             | follow-up events (`Purchase`, `CompleteRegistration`) |
| `invite:pool` (LIST) | invite-link strings                           | `InvitePoolService.refill` (cron)                   | `InvitePoolService.take` (`POST /track/click`)        |

Dropping any of the first three breaks attribution.

### Postgres (config source of truth)

Single table:

```sql
Setting (key TEXT PRIMARY KEY, value TEXT, updatedAt TIMESTAMP)
```

Written only from `/admin/settings` via `SettingsService.setMany` inside a single `$transaction`.

## Settings cascade

`SettingsService.get(key)` walks three steps and returns the first non-empty hit:

1. **Postgres** — `Setting` row set through `/admin`.
2. **`.env`** — bootstrap and infrastructure keys (`DATABASE_URL`, `REDIS_URL`, `BOT_TOKEN`).
3. **Schema default** (`SETTINGS[]` in `settings.service.ts`) — e.g. `v21.0` for `FB_API_VERSION`, `200/50/120` for the pool.

`getRequired(key)` throws when nothing resolves.

Hot vs restart-bound:

- **Hot** (re-read on every call): `FB_*`, `LANDING_URL`, `CHANNEL_ID`, `POOL_*`. UI edits take effect on the next request / cron tick.
- **Restart** required: `BOT_TOKEN`. Telegraf is instantiated once in `TelegrafModule.forRootAsync` and holds the token in memory.

`BOT_TOKEN` is intentionally [hidden from `/admin`](admin-ui.md#why-bot_token-is-not-in-the-ui) — `.env` owns it.

## Modules

| Module         | Responsibility                                                                                                                                                                                                                                                              |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tracking/`    | `POST /track/click` — persist click context, pull invite link from the pool, bind it, fire `Lead`. CAPI runs without `await` (`.catch(() => undefined)`) so the frontend response is never blocked.                                                                         |
| `invite-pool/` | Keep N pre-created invite links in the Redis list `invite:pool`. `@Cron(EVERY_30_SECONDS)` refills in small batches with a delay between `createChatInviteLink` calls (anti-rate-limit). `take()` does `RPOP`; the live-create fallback is a degraded mode, not the design. |
| `telegram/`    | `@On('chat_member')` handler. Considers a join only when `old_status ∈ {left, kicked}` AND `new_status ∈ {member, restricted}` AND `invite_link` is present AND the user is not a bot. Writes `tg:{userId} → clickId`, fires `Subscribe`.                                   |
| `capi/`        | `CapiService.send(ConversionEvent)`. Builds `fbc` from `fbclid + ts` when the cookie was not captured; a real `_fbc` always wins. `fbc/fbp/IP/UA` are **not** hashed; `external_id` is SHA-256 of the trimmed-lowercased value.                                             |
| `settings/`    | `SettingsService` + `/admin` (HTML UI + JSON API under `AdminGuard`).                                                                                                                                                                                                       |
| `redis/`       | `@Global` ioredis client exported under the `REDIS` token.                                                                                                                                                                                                                  |
| `prisma/`      | `@Global` `PrismaService extends PrismaClient`. `onModuleInit` connects, `onModuleDestroy` disconnects.                                                                                                                                                                     |

## Non-obvious invariants

1. **`allowedUpdates: ['chat_member', ...]`** in `TelegrafModule` is mandatory. Without it Telegram silently stops delivering `chat_member` updates and the whole attribution layer goes dark with no error in the logs. See the [Bot API docs](https://core.telegram.org/bots/api#getupdates).
2. **The bot must be a channel admin with `can_invite_users`.** Otherwise `createChatInviteLink` 403s → the pool never fills → `/track/click` starts returning `{ok: false, error: 'no_invite_link'}`.
3. **`app.set('trust proxy', true)`** in `main.ts`. CAPI match quality depends on the client IP — behind nginx/cloudflare without `trust proxy` the Graph API would receive the server's IP, not the user's.
4. **`dropPendingUpdates: true`** on Telegraf launch. Restarting the process drops the queued `chat_member` events. Joins that happen during a restart are lost and not recoverable.
5. **`strictNullChecks: false`** in `tsconfig.json`. The compiler will not catch `null`/`undefined` in `ctx.update` payloads or Redis return values — handle them explicitly.
6. **`POOL_MIN_SIZE=0` does NOT disable the pool.** The code reads `(await getNumber('POOL_MIN_SIZE')) || 200` — a falsy `0` is replaced by the default. To run a tiny pool use `1`.

## Adding deeper conversion events

To emit `CompleteRegistration` / `Purchase` further down the funnel, resolve the click via `TrackingService.getClickByUser(userId)`, then call `CapiService.send` with the appropriate `eventName` and a stable `eventId` — convention is `<event>_<clickId>` for pixel dedup.
