/* BusinessFinder reviews proxy — Cloudflare Worker.
 *
 * Keeps the Google Places API key server-side. The browser calls this Worker,
 * never Google directly, so the key is never exposed in the public web app.
 *
 * Deploy with Wrangler (see proxy/README.md). Set the secret:
 *   wrangler secret put GOOGLE_PLACES_API_KEY
 *
 * Endpoints:
 *   GET /reviews?name=<Business Name>&lat=<lat>&lng=<lng>
 *     -> { rating, userRatingCount, googleMapsUri, reviews: [...] }  (newest first)
 *   GET /health -> { ok: true }
 *
 * Reviews are capped at 5 by Google's API; we sort them newest-first here.
 */

const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';

// Only these origins may call the proxy (prevents other sites using your key).
const ALLOWED_ORIGINS = [
  'https://nirpilo.github.io',
  'http://localhost:8731',
  'http://127.0.0.1:8731',
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600', // 10 min CDN/browser cache
      ...corsHeaders(origin),
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (url.pathname === '/health') {
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname !== '/reviews') {
      return json({ error: 'Not found' }, 404, origin);
    }

    const name = (url.searchParams.get('name') || '').trim();
    const lat = parseFloat(url.searchParams.get('lat'));
    const lng = parseFloat(url.searchParams.get('lng'));

    if (!name || Number.isNaN(lat) || Number.isNaN(lng)) {
      return json({ error: 'name, lat and lng are required' }, 400, origin);
    }

    if (!env.GOOGLE_PLACES_API_KEY) {
      return json({ error: 'Server missing GOOGLE_PLACES_API_KEY' }, 500, origin);
    }

    // Ask Google only for the fields we show, to minimize billing SKU.
    const fieldMask = [
      'places.id',
      'places.displayName',
      'places.rating',
      'places.userRatingCount',
      'places.googleMapsUri',
      'places.reviews',
    ].join(',');

    const body = {
      textQuery: name,
      // Bias strongly to the business's location so we match the right place.
      locationBias: {
        circle: {
          center: { latitude: lat, longitude: lng },
          radius: 200.0,
        },
      },
      maxResultCount: 1,
    };

    let googleRes;
    try {
      googleRes = await fetch(TEXT_SEARCH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY,
          'X-Goog-FieldMask': fieldMask,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return json({ error: 'Upstream request failed' }, 502, origin);
    }

    if (!googleRes.ok) {
      const detail = await googleRes.text().catch(() => '');
      return json(
        { error: `Google responded ${googleRes.status}`, detail: detail.slice(0, 300) },
        googleRes.status,
        origin
      );
    }

    const data = await googleRes.json();
    const place = (data.places || [])[0];

    if (!place) {
      // No match found: return an empty-but-valid payload so the client can
      // simply show "no Google data" rather than treat it as an error.
      return json({ matched: false, reviews: [] }, 200, origin);
    }

    const reviews = (place.reviews || [])
      .map((r) => ({
        author: r.authorAttribution?.displayName || 'Anonymous',
        rating: r.rating ?? null,
        text: r.text?.text || r.originalText?.text || '',
        relativeTime: r.relativePublishTimeDescription || '',
        publishTime: r.publishTime || '',
      }))
      // Newest first.
      .sort((a, b) => new Date(b.publishTime) - new Date(a.publishTime));

    return json(
      {
        matched: true,
        placeId: place.id || '',
        rating: place.rating ?? null,
        userRatingCount: place.userRatingCount ?? 0,
        googleMapsUri: place.googleMapsUri || '',
        reviews,
      },
      200,
      origin
    );
  },
};
