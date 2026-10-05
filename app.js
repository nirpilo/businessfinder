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

  for (const b of businesses) {
    const li = document.createElement('li');
    li.className = 'result-card';

    const tags = [];
    if (b.cuisine) tags.push(`<span class="tag">${escapeHtml(b.cuisine.replace(/;/g, ', '))}</span>`);
    if (b.openingHours) tags.push(`<span class="tag">🕒 ${escapeHtml(b.openingHours)}</span>`);

    const actions = [];
    const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${b.lat},${b.lng}`;
    actions.push(`<a class="action-link" href="${mapsUrl}" target="_blank" rel="noopener">Directions</a>`);
    if (b.phone) {
      actions.push(`<a class="action-link" href="tel:${encodeURIComponent(b.phone)}">Call</a>`);
    }
    if (b.website) {
      actions.push(`<a class="action-link" href="${escapeHtml(b.website)}" target="_blank" rel="noopener">Website</a>`);
    }

    li.innerHTML = `
      <div class="result-top">
        <h3 class="result-name">${escapeHtml(b.name)}</h3>
        <span class="result-distance">${formatDistance(b.distance)}</span>
      </div>
      ${b.address ? `<p class="result-meta">${escapeHtml(b.address)}</p>` : ''}
      ${tags.length ? `<div class="result-tags">${tags.join('')}</div>` : ''}
      <div class="result-actions">${actions.join('')}</div>
    `;
    el.resultsList.appendChild(li);
  }
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
  };
} else {
  init();
}
