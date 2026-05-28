# Admin UI

Web form for editing runtime configuration. Served at `/admin` behind a bearer token.

## Access

`http://localhost:3000/admin` → the form prompts for a token → paste the `ADMIN_TOKEN` from `.env` → the value is cached in `localStorage` and sent as `Authorization: Bearer …` on every `/admin/settings` request.

Generate a token:

```bash
openssl rand -hex 32
```

If `ADMIN_TOKEN` is unset on the server, the guard returns 401 for any request — even a syntactically valid bearer.

## Source badge

Every field shows a `source` badge indicating where the effective value comes from:

| Source    | Meaning                                                 | How to land in this state                       |
| --------- | ------------------------------------------------------- | ----------------------------------------------- |
| `runtime` | Overridden via UI, stored in Postgres `Setting`.        | Any UI save with a non-empty value.             |
| `env`     | Not in DB, falls back to `.env`.                        | Put it in `.env`, leave the UI field empty.     |
| `default` | Neither DB nor env — schema default kicks in.           | Automatic (only fields that have a default).    |
| `unset`   | Not configured anywhere. Red badge for required fields. | The app throws on the first `getRequired` call. |

**Clearing a runtime override:** save the field empty. The value falls back to `env`/`default`/`unset`. Useful for rolling back an experiment.

## Field reference

### Telegram

| Key          | Type   | Required | Description                                                                       |
| ------------ | ------ | -------- | --------------------------------------------------------------------------------- |
| `CHANNEL_ID` | string | ✓        | Numeric channel id (`-100xxxxxxxxxx`). `@username` works too but the id is safer. |

`BOT_TOKEN` is not exposed here — see below.

### Facebook CAPI

| Key                  | Type            | Required | Description                                                                                                                      |
| -------------------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `FB_PIXEL_ID`        | string          | ✓        | Pixel ID from Events Manager.                                                                                                    |
| `FB_CAPI_TOKEN`      | string (secret) | ✓        | System User access token (Events Manager → Settings → Conversions API → Generate).                                               |
| `FB_API_VERSION`     | string          | —        | Defaults to `v21.0`. Bump when Meta releases a newer version.                                                                    |
| `FB_TEST_EVENT_CODE` | string          | —        | Code from the **Test Events** tab. When set, events appear there in real-time with match-quality breakdown. Clear in production. |
| `LANDING_URL`        | string          | —        | Landing URL. Goes into `event_source_url` on every CAPI event.                                                                   |

### Invite-link pool

| Key                    | Type   | Default | Description                                                                                                                                                                                            |
| ---------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POOL_MIN_SIZE`        | number | 200     | Pool target size in Redis. When it drops below this, cron tops up. ⚠ Value `0` does NOT work (see invariant 6 in [architecture.md](architecture.md#non-obvious-invariants)) — for a tiny pool use `1`. |
| `POOL_REFILL_BATCH`    | number | 50      | Links created per cron tick. Too high → Telegram flood-limit.                                                                                                                                          |
| `POOL_REFILL_DELAY_MS` | number | 120     | Delay between `createChatInviteLink` calls within a batch. Anti-rate-limit.                                                                                                                            |

**First-run tip:** start with `POOL_MIN_SIZE=5`, verify the full chain, then ramp up. Cold-starting at `POOL_MIN_SIZE=200` triggers 200 Telegram API calls back-to-back and can hit the flood limit.

## Why `BOT_TOKEN` is not in the UI

Telegraf is instantiated once in `TelegrafModule.forRootAsync` at process start and holds the token in memory. It cannot be swapped at runtime — a restart is required. Exposing it in the UI would suggest a hot reload that does not actually happen.

`BOT_TOKEN` lives **only in `.env`**. If you really need it in the DB (e.g. to avoid env files at deploy time), seed it directly via `bun run db:studio` → `Setting` table → `INSERT key='BOT_TOKEN' value='...'`. The cascade in `get()` will pick it up. Rare case.

## What happens if you…

| Action                                        | Effect                                                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Save `CHANNEL_ID` pointing at a new channel   | The existing Redis pool is now invalid (links target the old channel). Flush it: `docker compose exec redis redis-cli DEL invite:pool`. Otherwise subsequent `/track/click` calls hand out stale invites. |
| Change `FB_PIXEL_ID` or `FB_CAPI_TOKEN`       | Applies on the next `Lead`/`Subscribe`. In-flight events (already queued) go to the new pixel.                                                                                                            |
| Raise `POOL_MIN_SIZE` sharply (e.g. 5 → 1000) | The next cron ticks will burst many `createChatInviteLink` calls. Ramp gradually and/or raise `POOL_REFILL_DELAY_MS`.                                                                                     |
| Clear `FB_TEST_EVENT_CODE`                    | `test_event_code` stops being sent — events move out of the Test Events tab into production analytics.                                                                                                    |
