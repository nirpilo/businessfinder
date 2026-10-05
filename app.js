'use strict';

/* BusinessFinder — pure client-side.
 * Finds businesses near the user by category using the free OpenStreetMap
 * Overpass API. No API key, no server, no cost. */

// --- Category definitions -------------------------------------------------
// Each category maps to one or more OSM key/value filters. Overpass matches
// nodes/ways/relations carrying any of these tags.
const CATEGORIES = [
  { id: 'restaurant', label: 'Restaurant', emoji: '🍽️', filters: [['amenity', 'restaurant']] },
  { id: 'cafe', label: 'Café', emoji: '☕', filters: [['amenity', 'cafe']] },
  { id: 'bar', label: 'Bar / Pub', emoji: '🍺', filters: [['amenity', 'bar'], ['amenity', 'pub']] },
  { id: 'fast_food', label: 'Fast food', emoji: '🍔', filters: [['amenity', 'fast_food']] },
  { id: 'massage', label: 'Massage', emoji: '💆', filters: [['shop', 'massage'], ['leisure', 'spa']] },
  { id: 'hairdresser', label: 'Hair salon', emoji: '💇', filters: [['shop', 'hairdresser']] },
  { id: 'beauty', label: 'Beauty', emoji: '💅', filters: [['shop', 'beauty']] },
  { id: 'pharmacy', label: 'Pharmacy', emoji: '💊', filters: [['amenity', 'pharmacy']] },
  { id: 'supermarket', label: 'Supermarket', emoji: '🛒', filters: [['shop', 'supermarket']] },
  { id: 'bakery', label: 'Bakery', emoji: '🥐', filters: [['shop', 'bakery']] },
  { id: 'gym', label: 'Gym', emoji: '🏋️', filters: [['leisure', 'fitness_centre'], ['leisure', 'sports_centre']] },
  { id: 'hotel', label: 'Hotel', emoji: '🏨', filters: [['tourism', 'hotel'], ['tourism', 'guest_house']] },
  { id: 'bank', label: 'Bank / ATM', emoji: '🏦', filters: [['amenity', 'bank'], ['amenity', 'atm']] },
  { id: 'fuel', label: 'Gas station', emoji: '⛽', filters: [['amenity', 'fuel']] },
  { id: 'doctor', label: 'Doctor', emoji: '🩺', filters: [['amenity', 'doctors'], ['amenity', 'clinic']] },
  { id: 'dentist', label: 'Dentist', emoji: '🦷', filters: [['amenity', 'dentist']] },
  { id: 'car_repair', label: 'Car repair', emoji: '🔧', filters: [['shop', 'car_repair']] },
  { id: 'laundry', label: 'Laundry', emoji: '🧺', filters: [['shop', 'laundry'], ['shop', 'dry_cleaning']] },
];

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

// Optional Google reviews proxy (Cloudflare Worker). Leave empty to disable the
// ratings/reviews feature and keep the app fully free + keyless. When set, each
// card lazily fetches the business's Google rating, review count, and up to 5
// latest reviews. See proxy/README.md for how to deploy and get this URL.
//
// You can set this without editing this file by defining
// window.BUSINESSFINDER_PROXY_URL (e.g. in a small config.js script tag) which
// takes precedence over this default.
const REVIEWS_PROXY_URL_DEFAULT = '';
const REVIEWS_PROXY_URL =
  (typeof window !== 'undefined' && window.BUSINESSFINDER_PROXY_URL) ||
  REVIEWS_PROXY_URL_DEFAULT;

// How many results per search to enrich with Google reviews. Capped to limit
// Places API calls (billing) and keep the proxy's free tier comfortable.
const MAX_REVIEW_LOOKUPS = 10;

// --- State ----------------------------------------------------------------
const state = {
  location: null, // { lat, lng }
  activeCategory: null,
  requestId: 0, // guards against stale responses
};

// --- DOM refs --------------------------------------------------------------
// Populated by init() so this file can also be required in Node (tests)
// without touching `document`.
const el = {};

function bindDom() {
  el.categoryGrid = document.getElementById('categoryGrid');
  el.radius = document.getElementById('radius');
  el.locateBtn = document.getElementById('locateBtn');
  el.locationStatus = document.getElementById('locationStatus');
  el.resultsHeader = document.getElementById('resultsHeader');
  el.resultsTitle = document.getElementById('resultsTitle');
  el.resultsCount = document.getElementById('resultsCount');
  el.status = document.getElementById('status');
  el.resultsList = document.getElementById('resultsList');
}

// --- Helpers ---------------------------------------------------------------

// Haversine distance in meters between two lat/lng points.
function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function formatDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

// Build the Overpass QL query for a category around a point.
function buildOverpassQuery(category, loc, radius) {
  const clauses = [];
  for (const [k, v] of category.filters) {
    for (const type of ['node', 'way']) {
      clauses.push(`${type}["${k}"="${v}"](around:${radius},${loc.lat},${loc.lng});`);
    }
  }
  return `[out:json][timeout:25];(${clauses.join('')});out center tags;`;
}

// Extract a usable lat/lng from an Overpass element (node has lat/lon,
// way/relation have a center).
function elementLatLng(elm) {
  if (typeof elm.lat === 'number' && typeof elm.lon === 'number') {
    return { lat: elm.lat, lng: elm.lon };
  }
  if (elm.center) return { lat: elm.center.lat, lng: elm.center.lon };
  return null;
}

// Compose a human address from OSM address tags, if present.
function formatAddress(tags) {
  const parts = [];
  const line1 = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  if (line1) parts.push(line1);
  if (tags['addr:city']) parts.push(tags['addr:city']);
  return parts.join(', ');
}

// Normalize a raw Overpass element into a business record. Returns null if it
// has no name or no coordinates (not useful to show).
function toBusiness(elm, origin) {
  const tags = elm.tags || {};
  if (!tags.name) return null;
  const ll = elementLatLng(elm);
  if (!ll) return null;
  return {
    id: `${elm.type}/${elm.id}`,
    name: tags.name,
    lat: ll.lat,
    lng: ll.lng,
    address: formatAddress(tags),
    phone: tags.phone || tags['contact:phone'] || '',
    website: tags.website || tags['contact:website'] || '',
    openingHours: tags.opening_hours || '',
    cuisine: tags.cuisine || '',
    distance: distanceMeters(origin, ll),
  };
}

// Build a Google Maps URL that opens the REAL business place (name + coords),
// not just a bare coordinate pin. Including the name makes Google resolve to the
// actual listing with photos, reviews, and Street View. If a specific Google
// place page is known (from the reviews proxy), prefer that exact URL.
function googlePlaceUrl(business, googleMapsUri) {
  if (googleMapsUri) return googleMapsUri;
  const q = encodeURIComponent(`${business.name} ${business.lat},${business.lng}`);
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

// Turn a full URL into a short, readable label like "example.com".
function prettyDomain(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname.replace(/\/$/, '') : '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
  }
}

// Build a star string like "★★★★☆" for a 0-5 rating (rounded to nearest half
// shown as a filled star threshold). Returns '' for no rating.
function starString(rating) {
  if (rating == null || Number.isNaN(rating)) return '';
  const rounded = Math.round(rating * 2) / 2; // nearest half
  const full = Math.floor(rounded);
  const half = rounded - full === 0.5;
  const empty = 5 - full - (half ? 1 : 0);
  return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
}

// Format a review count like 1234 -> "1,234".
function formatCount(n) {
  if (!n) return '0';
  return Number(n).toLocaleString('en-US');
}

// Sort an array of review objects newest-first by publishTime (ISO string).
// Defensive: the proxy already sorts, but we re-sort in case of mixed sources.
function sortReviewsNewestFirst(reviews) {
  return [...(reviews || [])].sort(
    (a, b) => new Date(b.publishTime || 0) - new Date(a.publishTime || 0)
  );
}

// --- Rendering -------------------------------------------------------------

function renderCategories() {
  el.categoryGrid.innerHTML = '';
  for (const cat of CATEGORIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'category-btn';
    btn.dataset.id = cat.id;
    btn.innerHTML = `<span class="emoji" aria-hidden="true">${cat.emoji}</span><span>${cat.label}</span>`;
    btn.addEventListener('click', () => onCategoryClick(cat));
    el.categoryGrid.appendChild(btn);
  }
  updateCategoryEnabled();
}

function updateCategoryEnabled() {
  const hasLoc = !!state.location;
  for (const btn of el.categoryGrid.querySelectorAll('.category-btn')) {
    btn.disabled = !hasLoc;
    btn.classList.toggle('active', btn.dataset.id === state.activeCategory);
  }
}

function setStatus(html, isError = false) {
  el.status.innerHTML = html;
  el.status.classList.toggle('error', isError);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function renderResults(businesses, category) {
  el.resultsHeader.hidden = false;
  el.resultsTitle.textContent = category.label;
  el.resultsCount.textContent = businesses.length
    ? `${businesses.length} found`
    : '';
  el.resultsList.innerHTML = '';

  if (!businesses.length) {
    setStatus(`No ${category.label.toLowerCase()} found within range. Try a larger radius.`);
    return;
  }
  setStatus('');

  const reviewsEnabled = !!REVIEWS_PROXY_URL;

  businesses.forEach((b, index) => {
    const li = document.createElement('li');
    li.className = 'result-card';

    const tags = [];
    if (b.cuisine) tags.push(`<span class="tag">${escapeHtml(b.cuisine.replace(/;/g, ', '))}</span>`);
    if (b.openingHours) tags.push(`<span class="tag">🕒 ${escapeHtml(b.openingHours)}</span>`);

    const placeUrl = googlePlaceUrl(b);
    const directionsUrl =
      `https://www.google.com/maps/dir/?api=1&destination=` +
      encodeURIComponent(`${b.name} ${b.lat},${b.lng}`);

    const actions = [];
    // Real Google location view (photos / Street View / the actual listing).
    actions.push(
      `<a class="action-link action-view" href="${placeUrl}" target="_blank" rel="noopener">View on Google</a>`
    );
    actions.push(
      `<a class="action-link" href="${directionsUrl}" target="_blank" rel="noopener">Directions</a>`
    );
    if (b.phone) {
      actions.push(`<a class="action-link" href="tel:${encodeURIComponent(b.phone)}">Call</a>`);
    }
    if (b.website) {
      actions.push(`<a class="action-link" href="${escapeHtml(b.website)}" target="_blank" rel="noopener">Website</a>`);
    }

    // Address line: always present. Fall back to a Google place link when OSM
    // has no structured address, so the user can still find the exact spot.
    const addressLine = b.address
      ? `<p class="result-meta result-address">📍 ${escapeHtml(b.address)}</p>`
      : `<p class="result-meta result-address muted"><a href="${placeUrl}" target="_blank" rel="noopener">📍 See location on Google</a></p>`;

    // Website line: readable, tappable domain shown on the card body.
    const websiteLine = b.website
      ? `<p class="result-meta result-website">🔗 <a href="${escapeHtml(b.website)}" target="_blank" rel="noopener">${escapeHtml(prettyDomain(b.website))}</a></p>`
      : '';

    // Reviews slot: shown only when the proxy is configured. Starts as a small
    // loading line, then is filled in by enrichWithReviews().
    const willEnrich = reviewsEnabled && index < MAX_REVIEW_LOOKUPS;
    const reviewsSlot = reviewsEnabled
      ? `<div class="result-reviews" data-reviews="${willEnrich ? 'pending' : 'skip'}">${
          willEnrich
            ? '<span class="reviews-loading"><span class="spinner" aria-hidden="true"></span>Loading Google reviews…</span>'
            : ''
        }</div>`
      : '';

    li.innerHTML = `
      <div class="result-top">
        <h3 class="result-name">${escapeHtml(b.name)}</h3>
        <span class="result-distance">${formatDistance(b.distance)}</span>
      </div>
      ${addressLine}
      ${websiteLine}
      ${tags.length ? `<div class="result-tags">${tags.join('')}</div>` : ''}
      ${reviewsSlot}
      <div class="result-actions">${actions.join('')}</div>
    `;
    el.resultsList.appendChild(li);

    if (willEnrich) {
      enrichWithReviews(b, li.querySelector('.result-reviews'), li);
    }
  });
}

// Fetch Google rating + reviews for one business via the proxy and render them
// into the card's reviews slot. Failures degrade silently (slot is cleared).
async function enrichWithReviews(business, slot, card) {
  if (!slot) return;
  try {
    const url =
      `${REVIEWS_PROXY_URL.replace(/\/$/, '')}/reviews` +
      `?name=${encodeURIComponent(business.name)}` +
      `&lat=${business.lat}&lng=${business.lng}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`proxy ${res.status}`);
    const data = await res.json();
    renderReviewsInto(slot, data);
    if (data && data.matched) upgradeCardFromGoogle(card, business, data);
  } catch (err) {
    console.warn('[BusinessFinder] reviews fetch failed:', err);
    slot.innerHTML = ''; // degrade gracefully: no reviews shown
    slot.dataset.reviews = 'error';
  }
}

// When Google matched the place, upgrade the card's links/text with Google's
// authoritative data: the exact place page, a real address, and a website if
// OSM didn't have one.
function upgradeCardFromGoogle(card, business, data) {
  if (!card) return;

  // Point "View on Google" (and the address fallback link) at the exact place.
  if (data.googleMapsUri) {
    for (const a of card.querySelectorAll('a.action-view, .result-address a')) {
      a.setAttribute('href', data.googleMapsUri);
    }
  }

  // Fill in the address from Google if OSM had none.
  if (!business.address && data.formattedAddress) {
    const addrEl = card.querySelector('.result-address');
    if (addrEl) {
      addrEl.classList.remove('muted');
      addrEl.innerHTML = `📍 ${escapeHtml(data.formattedAddress)}`;
    }
  }

  // Add a website line from Google if OSM had none.
  if (!business.website && data.website) {
    const hasWebsite = card.querySelector('.result-website');
    if (!hasWebsite) {
      const line = document.createElement('p');
      line.className = 'result-meta result-website';
      line.innerHTML = `🔗 <a href="${escapeHtml(data.website)}" target="_blank" rel="noopener">${escapeHtml(prettyDomain(data.website))}</a>`;
      const addrEl = card.querySelector('.result-address');
      if (addrEl && addrEl.nextSibling) {
        addrEl.parentNode.insertBefore(line, addrEl.nextSibling);
      } else {
        card.querySelector('.result-top')?.after(line);
      }
    }
  }
}

// Render a reviews payload (from the proxy) into a card slot.
function renderReviewsInto(slot, data) {
  if (!data || !data.matched || (data.rating == null && !(data.reviews || []).length)) {
    slot.innerHTML = '<p class="reviews-none">No Google rating yet.</p>';
    slot.dataset.reviews = 'none';
    return;
  }

  const ratingLine =
    data.rating != null
      ? `<div class="reviews-rating">
           <span class="stars" aria-hidden="true">${starString(data.rating)}</span>
           <span class="rating-value">${data.rating.toFixed(1)}</span>
           <span class="rating-count">(${formatCount(data.userRatingCount)} reviews)</span>
         </div>`
      : '';

  const reviews = sortReviewsNewestFirst(data.reviews).slice(0, 5);
  const reviewItems = reviews
    .map(
      (r) => `
      <li class="review-item">
        <div class="review-head">
          <span class="review-author">${escapeHtml(r.author || 'Anonymous')}</span>
          ${r.rating != null ? `<span class="review-stars" aria-hidden="true">${starString(r.rating)}</span>` : ''}
          ${r.relativeTime ? `<span class="review-time">${escapeHtml(r.relativeTime)}</span>` : ''}
        </div>
        ${r.text ? `<p class="review-text">${escapeHtml(r.text)}</p>` : ''}
      </li>`
    )
    .join('');

  const mapsLink = data.googleMapsUri
    ? `<a class="reviews-more" href="${escapeHtml(data.googleMapsUri)}" target="_blank" rel="noopener">All reviews on Google &rsaquo;</a>`
    : '';

  slot.innerHTML = `
    ${ratingLine}
    ${reviewItems ? `<ul class="review-list">${reviewItems}</ul>` : ''}
    ${mapsLink}
  `;
  slot.dataset.reviews = 'done';
}

// --- Actions ---------------------------------------------------------------

function setLocationStatus(text, cls = '') {
  el.locationStatus.textContent = text;
  el.locationStatus.className = `location-status ${cls}`.trim();
}

function requestLocation() {
  if (!('geolocation' in navigator)) {
    setLocationStatus('Geolocation is not supported on this device.', 'err');
    return;
  }
  setLocationStatus('Getting your location…');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      setLocationStatus('Location set. Pick a category.', 'ok');
      updateCategoryEnabled();
      // If a category was already chosen, refresh the search.
      if (state.activeCategory) {
        const cat = CATEGORIES.find((c) => c.id === state.activeCategory);
        if (cat) search(cat);
      }
    },
    (err) => {
      const msg =
        err.code === err.PERMISSION_DENIED
          ? 'Location permission denied. Enable it to search nearby.'
          : 'Could not get your location. Try again.';
      setLocationStatus(msg, 'err');
    },
    { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
  );
}

function onCategoryClick(category) {
  if (!state.location) {
    setLocationStatus('Set your location first (tap "Use my location").', 'err');
    return;
  }
  state.activeCategory = category.id;
  updateCategoryEnabled();
  search(category);
}

async function search(category) {
  const radius = Number(el.radius.value) || 2000;
  const myId = ++state.requestId;

  el.resultsHeader.hidden = false;
  el.resultsTitle.textContent = category.label;
  el.resultsCount.textContent = '';
  el.resultsList.innerHTML = '';
  setStatus('<span class="spinner" aria-hidden="true"></span>Searching nearby…');

  const query = buildOverpassQuery(category, state.location, radius);

  try {
    // Standard form encoding Overpass accepts broadly. (The browser supplies
    // its own User-Agent automatically; it cannot be set from fetch.)
    const res = await fetch(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`Overpass responded ${res.status}`);
    const data = await res.json();

    // Ignore if a newer request has started.
    if (myId !== state.requestId) return;

    const seen = new Set();
    const businesses = [];
    for (const elm of data.elements || []) {
      const b = toBusiness(elm, state.location);
      if (!b) continue;
      // De-dupe by name+rounded location (ways + nodes can overlap).
      const key = `${b.name}|${b.lat.toFixed(4)}|${b.lng.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      businesses.push(b);
    }
    businesses.sort((a, b) => a.distance - b.distance);

    renderResults(businesses, category);
  } catch (err) {
    if (myId !== state.requestId) return;
    setStatus(
      'Search failed. The free data service may be busy — wait a moment and try again.',
      true
    );
    console.error('[BusinessFinder] search error:', err);
  }
}

// --- Init ------------------------------------------------------------------

function init() {
  bindDom();
  renderCategories();
  el.locateBtn.addEventListener('click', requestLocation);
  el.radius.addEventListener('change', () => {
    if (state.location && state.activeCategory) {
      const cat = CATEGORIES.find((c) => c.id === state.activeCategory);
      if (cat) search(cat);
    }
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((e) =>
        console.warn('[BusinessFinder] SW registration failed:', e)
      );
    });
  }
}

// Expose a few pure helpers for testing in Node.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CATEGORIES,
    distanceMeters,
    formatDistance,
    buildOverpassQuery,
    formatAddress,
    toBusiness,
    elementLatLng,
    starString,
    formatCount,
    sortReviewsNewestFirst,
    googlePlaceUrl,
    prettyDomain,
  };
} else {
  init();
}
