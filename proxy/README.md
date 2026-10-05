# BusinessFinder reviews proxy

A tiny Cloudflare Worker that fetches Google ratings and reviews for a business,
keeping your Google API key secret. The web app calls this Worker; it never calls
Google directly, so the key is never in the browser.

## What it returns

`GET /reviews?name=<business name>&lat=<lat>&lng=<lng>`

```json
{
  "matched": true,
  "rating": 4.6,
  "userRatingCount": 231,
  "googleMapsUri": "https://maps.google.com/?cid=...",
  "reviews": [
    { "author": "Jane D.", "rating": 5, "text": "Great!", "relativeTime": "a week ago", "publishTime": "2026-09-27T..." }
  ]
}
```

Reviews are sorted newest first. Google's API returns at most **5** reviews per
place and the total `userRatingCount` separately, so the full-count number is
accurate even though only up to 5 review texts are shown.

## One-time setup

### 1. Get a Google Places API key

1. Go to https://console.cloud.google.com/ and create (or pick) a project.
2. Enable **Places API (New)**: APIs & Services -> Library -> search "Places API (New)" -> Enable.
3. APIs & Services -> Credentials -> Create credentials -> API key. Copy it.
4. **Lock it down** (important): edit the key ->
   - Application restrictions: *None* is fine (the key lives only on the Worker,
     not in the browser).
   - API restrictions: *Restrict key* -> select **Places API (New)** only.
5. **Set a budget cap** so you can never be surprised by a bill:
   Billing -> Budgets & alerts -> create a budget (e.g. $1 or $5) with email alerts.
   Google gives a recurring free monthly credit for Maps/Places; light personal
   use typically stays within it.

### 2. Deploy the Worker (free tier)

```bash
cd proxy
npx wrangler login            # opens a browser to authorize Cloudflare (free account)
npx wrangler secret put GOOGLE_PLACES_API_KEY   # paste your key when prompted
npx wrangler deploy
```

Wrangler prints a URL like:

```
https://businessfinder-reviews.<your-subdomain>.workers.dev
```

### 3. Point the app at the Worker

Open `../app.js`, find `REVIEWS_PROXY_URL`, and set it to your Worker URL:

```js
const REVIEWS_PROXY_URL = 'https://businessfinder-reviews.<your-subdomain>.workers.dev';
```

Commit and push. GitHub Pages redeploys automatically, and cards will start
showing Google ratings and reviews.

## Allowed origins

The Worker only answers requests from the origins listed in `ALLOWED_ORIGINS` at
the top of `worker.js` (your GitHub Pages site and localhost). Add your custom
domain there if you use one.

## Cost control notes

- The Worker requests a **minimal field mask** (rating, review count, reviews,
  maps link) to stay on the cheapest applicable billing SKU.
- Responses are cached for 10 minutes at the edge/browser to cut repeat calls.
- The app only calls the proxy for results actually shown, and you can disable it
  entirely by leaving `REVIEWS_PROXY_URL` empty.
