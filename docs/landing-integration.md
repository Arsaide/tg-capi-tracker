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

<a id="join-btn" href="#">Join channel</a>

<script>
    (async function () {
        const params = new URLSearchParams(location.search);
        const getCookie = n => (document.cookie.match('(^|; )' + n + '=([^;]*)') || [])[2];

        const res = await fetch('https://YOUR_BACKEND/track/click', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fbclid: params.get('fbclid') || undefined,
                fbp: getCookie('_fbp'),
                fbc: getCookie('_fbc'),
            }),
        });
        const { ok, inviteLink } = await res.json();
        const btn = document.getElementById('join-btn');
        if (ok && inviteLink && btn) btn.href = inviteLink;
    })();
</script>
```

What happens here:

1. **Meta Pixel base code** fires `PageView` in the browser and writes the `_fbp` (per-browser, stable) and `_fbc` (built from the `fbclid` URL param) cookies.
2. **A separate JS request** posts the click payload to the backend: `fbclid` from the URL (in case the `_fbc` cookie hasn't been written yet) plus both cookies.
3. **Backend** persists the context in Redis, pulls an invite link from the pool, binds it to the click, fires `Lead` server-side, and returns the `inviteLink`.
4. **JS rewrites the button's href** — the user clicks "Join" and walks through the personal link.

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
{ "ok": true, "inviteLink": "https://t.me/+abcDef123..." }
```

Or, when the pool is empty and the live-create fallback also failed:

```json
{ "ok": false, "error": "no_invite_link" }
```

## Deduplication with the pixel

Today the landing fires `PageView` via the pixel (browser) and `Lead` is sent server-side only (`POST /track/click`). No overlap by default → no dedup needed.

If you also fire `Lead` from the pixel (e.g. `fbq('track', 'Lead')` on the join button), pass the **same `event_id`** the server uses. The server generates `lead_<clickId>`, and `clickId` is server-side and not exposed to the frontend. To dedup, either return `clickId` from the controller and forward it to `fbq`, or generate a shared `eventId` on the frontend and pass it to the backend.

Example with `clickId` returned:

```js
const { ok, inviteLink, clickId } = await res.json();
if (clickId) fbq('track', 'Lead', {}, { eventID: 'lead_' + clickId });
```

(Requires extending the controller response with `clickId` — currently not returned.)

## CORS

`main.ts` runs `app.enableCors({ origin: true })`, accepting cross-origin requests from any Origin. Tighten to the landing's domain in production:

```ts
app.enableCors({ origin: 'https://your-landing.example' });
```

## Deeper events (CompleteRegistration / Purchase)

If a downstream bot/site in the funnel knows the Telegram `user_id` of the user:

```ts
const ctx = await tracking.getClickByUser(userId);
if (ctx) {
    await capi.send({
        eventName: 'CompleteRegistration',
        eventId: `reg_${clickId}`,
        ctx: { ...ctx, tgUserId: userId },
    });
}
```

`tg:{userId} → clickId` is written to Redis at join time (`TelegramUpdate.onChatMember`). While that mapping is alive (TTL 30 days) any follow-up event can be sent with correct attribution.

## Debugging match quality

1. Set `FB_TEST_EVENT_CODE` in `/admin` (Events Manager → **Test Events** tab → a code like `TEST12345`).
2. Walk the chain: landing → `Lead` should arrive in Test Events immediately.
3. Join from a second account using the issued invite link → `Subscribe` should arrive.
4. Match quality: each Test Events entry shows `% matched`. Expect 80–100% with `fbc + fbp + ip + ua + external_id` (after a join).

Things that hurt match quality:

- Landing without the pixel → no `_fbc`/`_fbp` cookies → only IP+UA make it through.
- Backend behind nginx without `trust proxy` → the server's IP, not the client's.
- `external_id` (Telegram user id) is hashed — this is correct, Meta expects SHA-256.
