# BusinessFinder

Find businesses near you by category, straight from your phone's browser. Pick a
category (restaurant, massage, pharmacy, and more), and it lists nearby places
sorted by distance with directions, phone, and website links.

- **No install, no login, no API key, no cost.**
- Runs 100% in the browser as static files.
- Uses your device's GPS and the free [OpenStreetMap Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API).
- Installable as a phone home-screen app (PWA) and loads offline (the shell).

## How to use

1. Open `index.html` over **HTTPS** (geolocation requires a secure context) or
   `http://localhost` for local testing.
2. Tap **Use my location** and allow the location prompt.
3. Tap a category. Results appear, closest first.
4. Tap **Directions**, **Call**, or **Website** on any result.

Change the radius (1-10 km) at any time to re-run the current search.

## Run locally

Any static file server works. For example:

```bash
cd BusinessFinder
python3 -m http.server 8731
# then open http://localhost:8731
```

Geolocation and the service worker only work on `localhost` or HTTPS, not from a
`file://` URL.

## Deploy (free, no server)

Drop the folder on any static host and you get an HTTPS URL your phone can open:

- GitHub Pages
- Cloudflare Pages
- Netlify / Vercel (static)

There is no backend to run. Everything is client-side.

## Tests

Pure helper functions (distance, query building, result parsing) have a
dependency-free test suite:

```bash
node app.test.js
```

## How it works

- **Categories** (`CATEGORIES` in `app.js`) map a friendly label to OpenStreetMap
  tags, e.g. Massage &rarr; `shop=massage` and `leisure=spa`.
- On search, the app builds an [Overpass QL](https://wiki.openstreetmap.org/wiki/Overpass_API/Overpass_QL)
  query for `node` and `way` elements of those tags within the chosen radius of
  your location, sends it to the public Overpass endpoint, then normalizes,
  de-duplicates, and sorts the results by distance.
- The service worker (`sw.js`) caches the app shell so the page is installable
  and loads offline. Live search data is always fetched from the network.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | App shell and layout |
| `styles.css` | Mobile-first styling |
| `app.js` | Categories, geolocation, Overpass query, rendering |
| `app.test.js` | Unit tests for the pure helpers |
| `sw.js` | Service worker (offline shell) |
| `manifest.json` | PWA manifest |
| `icons/` | App icons (192, 512) |

## Notes and limits

- The Overpass public API is a shared free service. If a search fails with a busy
  message, wait a moment and try again.
- OpenStreetMap data is community-maintained, so coverage and details (hours,
  phone, website) vary by area. Ratings and photos are not provided.

Data &copy; OpenStreetMap contributors, licensed under the
[ODbL](https://www.openstreetmap.org/copyright).
