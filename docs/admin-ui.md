# Admin UI

Web form for editing runtime configuration. Served at `/admin` behind a bearer token.

## Access

`http://localhost:3000/admin` → the form prompts for a token → paste the `ADMIN_TOKEN` from `.env` → the value is cached in `localStorage` and sent as `Authorization: Bearer …` on every `/admin/settings` request.

Generate a token:

```bash
openssl rand -hex 32
```

If `ADMIN_TOKEN` is unset on the server, the guard returns 401 for any request — even a syntactically valid bearer. `ADMIN_TOKEN` also guards the server-to-server `/track/bot/*` endpoints the welcome bot calls, so treat it as a shared secret between the server and the bot.

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

| Key                    | Type   | Required | Description                                                                                                                                |
| ---------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `WELCOME_BOT_USERNAME` | string | ✓        | `@username` of the welcome bot (store **without** the `@`). `/track/click` builds `https://t.me/<username>?start=<clickId>` from it. |

### Facebook CAPI

| Key                  | Type            | Required | Description                                                                                                                      |
| -------------------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `FB_PIXEL_ID`        | string          | ✓        | Pixel ID from Events Manager.                                                                                                    |
| `FB_CAPI_TOKEN`      | string (secret) | ✓        | System User access token (Events Manager → Settings → Conversions API → Generate).                                               |
| `FB_API_VERSION`     | string          | —        | Defaults to `v21.0`. Bump when Meta releases a newer version.                                                                    |
| `FB_TEST_EVENT_CODE` | string          | —        | Code from the **Test Events** tab. When set, events appear there in real-time with match-quality breakdown. Clear in production. |
| `LANDING_URL`        | string          | —        | Landing URL. Goes into `event_source_url` on every CAPI event.                                                                   |

## What happens if you…

| Action                                          | Effect                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Change `WELCOME_BOT_USERNAME`                   | Applies on the next `POST /track/click` — new links point at the new bot. Links already handed out to the landing keep pointing at the old bot until the page reloads. |
| Change `FB_PIXEL_ID` or `FB_CAPI_TOKEN`         | Applies on the next `Lead`. In-flight events (already queued) go to the new pixel.                                                                                   |
| Clear `FB_TEST_EVENT_CODE`                      | `test_event_code` stops being sent — events move out of the Test Events tab into production analytics.                                                               |
