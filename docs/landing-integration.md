# Landing integration

What to wire on the landing page so clicks and joins get attributed.

## HTML to embed

```html
<!-- 1) Meta Pixel base code: fires PageView and sets the _fbp / _fbc cookies (the latter from fbclid). -->
<script>
    !(function (f, b, e, v, n, t, s) {
        if (f.fbq) return;
        n = f.fbq = function () {
            n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n;
        n.push = n;
        n.loaded = !0;
        n.version = '2.0';
        n.queue = [];
        t = b.createElement(e);
        t.async = !0;
        t.src = v;
        s = b.getElementsByTagName(e)[0];
        s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', 'YOUR_PIXEL_ID');
    fbq('track', 'PageView');
</script>

<a id="join-btn" href="#">Launch the bot</a>

<script>
    (async function () {
        const params = new URLSearchParams(location.search);
        const getCookie = n => (document.cookie.match('(^|; )' + n + '=([^;]*)') || [])[2];

        const res = await fetch('https://api.alex-lab.online/track/click', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fbclid: params.get('fbclid') || undefined,
                fbp: getCookie('_fbp'),
                fbc: getCookie('_fbc'),
            }),
        });
        // `url` is the welcome-bot deep link. `inviteLink` is a deprecated alias of
        // the same value, kept so older landings keep working without a change.
        const { ok, url, inviteLink } = await res.json();
        const link = url || inviteLink;
        const btn = document.getElementById('join-btn');
        if (ok && link && btn) btn.href = link;
    })();
</script>
```

What happens here:

1. **Meta Pixel base code** fires `PageView` in the browser and writes the `_fbp` (per-browser, stable) and `_fbc` (built from the `fbclid` URL param) cookies.
2. **A separate JS request** posts the click payload to the backend: `fbclid` from the URL (in case the `_fbc` cookie hasn't been written yet) plus both cookies.
3. **Backend** persists the context in Redis and returns a **welcome-bot deep link** `https://t.me/<WELCOME_BOT_USERNAME>?start=<clickId>` — the `clickId` is the attribution key carried as the bot's `/start` payload. No CAPI event fires here (the site-stage event is the browser `PageView`).
4. **JS rewrites the button's href** — the user taps it, opens the welcome bot, and presses **Вступить в канал**. The welcome bot registers the attribution mapping (`POST /track/bot/start`) and routes the user to the channel's join-request invite link. When the user submits the join request, the AI-terminal bot (`alexlab_trade_bot`) approves it and calls `POST /track/bot/activate {tgUserId}` — the backend resolves the clickId from the stored mapping and fires `Lead`.

## `POST /track/click` contract

**Request:**

```json
{
    "fbclid": "IwAR0xxx...",
    "fbp": "fb.1.1700000000.987654321",
    "fbc": "fb.1.1700000000.IwAR0xxx..."
}
```

All three fields are optional. The backend uses whatever is present — priority is: existing `_fbc` cookie > built from `fbclid + ts`.

The server also reads `client_ip_address` and `client_user_agent` from HTTP headers (with `trust proxy` enabled, the first IP of `X-Forwarded-For` is used).

**Response:**

```json
{
    "ok": true,
    "url": "https://t.me/alex_welcome_bot?start=2f1c…",
    "inviteLink": "https://t.me/alex_welcome_bot?start=2f1c…",
    "clickId": "2f1c…"
}
```

`url` is canonical; `inviteLink` is a deprecated alias holding the same value so existing
landings keep working. `clickId` is returned for optional pixel dedup (see below).

If `WELCOME_BOT_USERNAME` is not configured on the server, `/track/click` throws (500) —
set it in `/admin` first.

## Deduplication with the pixel

The landing fires `PageView` via the pixel (browser); the server fires `Lead` only later, when the AI-terminal bot processes the channel join request (`POST /track/bot/activate {tgUserId}`). Different event names → no overlap, no dedup needed by default.

If you ALSO fire a pixel-side `Lead` somewhere (e.g. `fbq('track', 'Lead')`), dedup it against the server `Lead` by passing the **same `event_id`** — the server uses `lead_<clickId>`, and `clickId` is returned by `/track/click`:

```js
const { ok, url, clickId } = await res.json();
if (clickId) fbq('track', 'Lead', {}, { eventID: 'lead_' + clickId });
```

## CORS

`main.ts` runs `app.enableCors({ origin: true })`, accepting cross-origin requests from any Origin. Tighten to the landing's domain in production:

```ts
app.enableCors({ origin: 'https://your-landing.example' });
```

## Deeper events (CompleteRegistration / Purchase)

`tg:{userId} → clickId` is written to Redis when the welcome bot calls `/track/bot/start`.
While that mapping is alive (TTL 30 days) any follow-up event can be attributed by the
Telegram `user_id` alone — the clickId does **not** need to be forwarded into the
AI-terminal bot.

A downstream bot (e.g. the main trading bot confirming a deposit) `POST`s the event server-side
and the backend resolves the click:

```ts
const ctx = await tracking.getClickByUser(userId);
if (ctx) {
    await capi.send({
        eventName: 'Purchase',
        eventId: `purchase_${clickId}`,
        value: 50,
        currency: 'USD',
        ctx: { ...ctx, tgUserId: userId },
    });
}
```

This is a natural extension point — wire a `/track/bot/event` endpoint (guarded by
`ADMIN_TOKEN`, same as `/track/bot/activate`) that takes `{ tgUserId, eventName, value }`.

## `POST /track/bot/activate` — channel join attribution

Called by the AI-terminal bot from its `chat_join_request` handler, **after** approving
the join request:

```json
{ "tgUserId": "123456789" }
```

`clickId` is optional. When omitted the server resolves it from the stored
`tg:{tgUserId}` mapping (written earlier by `/track/bot/start`). Possible responses:

| Scenario | Response |
| --- | --- |
| Mapping found → `Lead` fired | `{ "ok": true, "attributed": true }` |
| No mapping (organic join, no prior site click) | `{ "ok": true, "attributed": false }` — no CAPI event |
| `clickId` passed explicitly | Backward-compatible; `Lead` fired using the supplied clickId |

## Debugging match quality

1. Set `FB_TEST_EVENT_CODE` in `/admin` (Events Manager → **Test Events** tab → a code like `TEST12345`).
2. Walk the chain: landing → welcome bot → channel join request → AI-terminal bot approves.
3. `Lead` should arrive in Test Events when the join request is approved.
4. Match quality: each Test Events entry shows `% matched`. Expect 80–100% with `fbc + fbp + ip + ua + external_id` (the channel join adds `external_id`).

Things that hurt match quality:

- Landing without the pixel → no `_fbc`/`_fbp` cookies → only IP+UA make it through.
- Backend behind nginx without `trust proxy` → the server's IP, not the client's.
- `external_id` (Telegram user id) is hashed — this is correct, Meta expects SHA-256.
- Note the IP/UA on `Lead` are the **landing** visitor's (captured at `/track/click`), not the welcome-bot request's — that is intentional and keeps them consistent with the `PageView` pixel hit.
