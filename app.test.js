'use strict';

// Lightweight assertions, no framework. Run: node app.test.js
const assert = require('node:assert');
const {
  CATEGORIES,
  distanceMeters,
  formatDistance,
  buildOverpassQuery,
  formatAddress,
  toBusiness,
  elementLatLng,
} = require('./app.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

// --- CATEGORIES ---
test('every category has id, label, emoji, and at least one filter', () => {
  assert.ok(CATEGORIES.length > 0);
  for (const c of CATEGORIES) {
    assert.ok(c.id && c.label && c.emoji, `category missing fields: ${JSON.stringify(c)}`);
    assert.ok(Array.isArray(c.filters) && c.filters.length > 0, `no filters: ${c.id}`);
    for (const f of c.filters) {
      assert.strictEqual(f.length, 2, `filter must be [key,value]: ${c.id}`);
    }
  }
});

test('category ids are unique', () => {
  const ids = CATEGORIES.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('massage category maps to the expected OSM tags', () => {
  const massage = CATEGORIES.find((c) => c.id === 'massage');
  assert.ok(massage);
  assert.deepStrictEqual(massage.filters, [['shop', 'massage'], ['leisure', 'spa']]);
});

// --- distanceMeters ---
test('distanceMeters is ~0 for identical points', () => {
  const p = { lat: 33.749, lng: -84.388 };
  assert.ok(distanceMeters(p, p) < 1);
});

test('distanceMeters matches a known distance (Atlanta ~1 deg lat ≈ 111 km)', () => {
  const a = { lat: 33, lng: -84 };
  const b = { lat: 34, lng: -84 };
  const d = distanceMeters(a, b);
  assert.ok(d > 110000 && d < 112000, `expected ~111km, got ${d}`);
});

// --- formatDistance ---
test('formatDistance uses meters under 1km and km above', () => {
  assert.strictEqual(formatDistance(250), '250 m');
  assert.strictEqual(formatDistance(1500), '1.5 km');
  assert.strictEqual(formatDistance(12000), '12 km');
});

// --- buildOverpassQuery ---
test('buildOverpassQuery includes radius, coords, and node+way for each filter', () => {
  const cat = CATEGORIES.find((c) => c.id === 'restaurant');
  const q = buildOverpassQuery(cat, { lat: 10, lng: 20 }, 3000);
  assert.ok(q.includes('[out:json]'));
  assert.ok(q.includes('around:3000,10,20'));
  assert.ok(q.includes('node["amenity"="restaurant"]'));
  assert.ok(q.includes('way["amenity"="restaurant"]'));
  assert.ok(q.trim().endsWith('out center tags;'));
});

test('buildOverpassQuery emits a clause per filter value', () => {
  const bar = CATEGORIES.find((c) => c.id === 'bar'); // bar + pub
  const q = buildOverpassQuery(bar, { lat: 1, lng: 2 }, 1000);
  assert.ok(q.includes('"amenity"="bar"'));
  assert.ok(q.includes('"amenity"="pub"'));
});

// --- elementLatLng ---
test('elementLatLng reads node lat/lon and way center', () => {
  assert.deepStrictEqual(elementLatLng({ lat: 1, lon: 2 }), { lat: 1, lng: 2 });
  assert.deepStrictEqual(
    elementLatLng({ center: { lat: 3, lon: 4 } }),
    { lat: 3, lng: 4 }
  );
  assert.strictEqual(elementLatLng({}), null);
});

// --- formatAddress ---
test('formatAddress composes housenumber, street, and city', () => {
  const addr = formatAddress({
    'addr:housenumber': '10',
    'addr:street': 'Main St',
    'addr:city': 'Atlanta',
  });
  assert.strictEqual(addr, '10 Main St, Atlanta');
});

test('formatAddress returns empty string when no address tags', () => {
  assert.strictEqual(formatAddress({}), '');
});

// --- toBusiness ---
test('toBusiness normalizes a node element with distance', () => {
  const origin = { lat: 33.0, lng: -84.0 };
  const elm = {
    type: 'node',
    id: 42,
    lat: 33.001,
    lon: -84.0,
    tags: { name: "Joe's Diner", amenity: 'restaurant', phone: '+1 555 0100' },
  };
  const b = toBusiness(elm, origin);
  assert.strictEqual(b.id, 'node/42');
  assert.strictEqual(b.name, "Joe's Diner");
  assert.strictEqual(b.phone, '+1 555 0100');
  assert.ok(b.distance > 0 && b.distance < 200);
});

test('toBusiness returns null when name is missing', () => {
  const b = toBusiness(
    { type: 'node', id: 1, lat: 1, lon: 1, tags: { amenity: 'restaurant' } },
    { lat: 0, lng: 0 }
  );
  assert.strictEqual(b, null);
});

test('toBusiness returns null when coordinates are missing', () => {
  const b = toBusiness(
    { type: 'way', id: 1, tags: { name: 'No Coords' } },
    { lat: 0, lng: 0 }
  );
  assert.strictEqual(b, null);
});

test('toBusiness falls back to contact:* tags for phone and website', () => {
  const b = toBusiness(
    {
      type: 'node',
      id: 5,
      lat: 0,
      lon: 0,
      tags: {
        name: 'Spa',
        'contact:phone': '555-1234',
        'contact:website': 'https://spa.example',
      },
    },
    { lat: 0, lng: 0 }
  );
  assert.strictEqual(b.phone, '555-1234');
  assert.strictEqual(b.website, 'https://spa.example');
});

console.log(`\n${passed} tests passed.`);
