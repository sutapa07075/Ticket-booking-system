const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const maps = require('../services/googleMaps.service');
const polylineSvc = require('../services/polyline.service');

const router = express.Router();

// GET /api/places/autocomplete?input=how&session=uuid
router.get('/autocomplete', async (req, res) => {
  const { input, session } = req.query;
  if (!input || input.length < 2) return res.json({ predictions: [] });
  try {
    const predictions = await maps.autocomplete(input, session);
    res.json({ predictions });
  } catch (e) {
    console.error('[places/autocomplete]', e.message); // <-- check your server console for the real Google error
    res.status(502).json({ error: 'Places lookup failed', detail: e.message, googleStatus: e.googleStatus });
  }
});

// POST /api/places/resolve  { place_id }  -> caches into `locations` table
router.post('/resolve', async (req, res) => {
  const { place_id } = req.body;
  if (!place_id) return res.status(400).json({ error: 'place_id required' });

  let loc = db.prepare(`SELECT * FROM locations WHERE place_id = ?`).get(place_id);
  if (loc) return res.json({ location: loc });

  try {
    const details = await maps.placeDetails(place_id);
    if (!details) return res.status(404).json({ error: 'Place not found' });

    const id = uuidv4();
    db.prepare(
      `INSERT INTO locations (id, place_id, name, formatted_address, lat, lng, city, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, details.place_id, details.name, details.formatted_address, details.lat, details.lng, details.city, details.state);

    loc = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(id);
    res.json({ location: loc });
  } catch (e) {
    res.status(502).json({ error: 'Place resolve failed', detail: e.message });
  }
});

// ---------- Manual fallback: create a location without Places API at all ----------
// Used when Places Autocomplete isn't available on the current API key
// (not enabled, no billing, quota, etc). Lets an official or passenger type
// a plain place name + optional coordinates instead of picking a Google
// suggestion. No Google call is made at all — this always works.
router.post('/manual', (req, res) => {
  const { name, lat, lng, city, state } = req.body;
  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'A location name (at least 2 characters) is required' });
  }

  const id = uuidv4();
  db.prepare(
    `INSERT INTO locations (id, place_id, name, formatted_address, lat, lng, city, state)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`
  ).run(id, name.trim(), name.trim(), lat ?? null, lng ?? null, city || null, state || null);

  const loc = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(id);
  res.status(201).json({ location: loc, manual: true });
});

// ---------- Route preview: real road route between two points ----------
// Uses the Routes API "Compute Routes" (demo-key supported) instead of the
// legacy Directions API. Returns an encoded polyline the frontend decodes
// and draws itself with a plain google.maps.Polyline — no DirectionsRenderer
// needed (that's tied to the legacy, non-demo-key Directions API).
router.get('/route-preview', async (req, res) => {
  const { originLat, originLng, destLat, destLng } = req.query;
  if (!originLat || !originLng || !destLat || !destLng) {
    return res.status(400).json({ error: 'originLat, originLng, destLat, destLng are all required' });
  }
  try {
    const route = await maps.computeRoute(
      { lat: Number(originLat), lng: Number(originLng) },
      { lat: Number(destLat), lng: Number(destLng) }
    );
    if (!route) return res.status(404).json({ error: 'No route found between these points' });
    res.json(route);
  } catch (e) {
    console.error('[places/route-preview]', e.message);
    res.status(502).json({ error: 'Route lookup failed', detail: e.message });
  }
});

// ---------- Transfer-point suggestions ----------
// Given a picked point (typed name, autocomplete result, or map click),
// finds existing locations within `radiusM` that are ALREADY used as the
// origin, destination, or an intermediate stop of some other active route.
// Route-change ("connecting") search only links two routes at a shared stop
// if both routes point at the EXACT SAME locations row (or one within 300m —
// see routeSearch.service.js's samePhysical()). Two officials independently
// typing "Santragachi" can easily end up with two different rows a few
// hundred metres apart, silently breaking that link. This endpoint lets the
// route-builder UI say "hey, this looks like a stop that already exists on
// route X — reuse it" instead of creating a near-duplicate.
router.get('/transfer-suggestions', (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const radiusM = Number(req.query.radiusM) || 500;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng required' });
  }

  // Coarse bounding box first (cheap, uses the index-free lat/lng columns),
  // then refine with real haversine distance — better-sqlite3/SQLite has no
  // built-in trig functions.
  const degPad = radiusM / 111000; // ~111km per degree of latitude
  const candidates = db.prepare(
    `SELECT * FROM locations WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND lat IS NOT NULL AND lng IS NOT NULL`
  ).all(lat - degPad, lat + degPad, lng - degPad, lng + degPad);

  const nearby = candidates
    .map((l) => ({ ...l, distanceM: polylineSvc.haversineM({ lat, lng }, { lat: l.lat, lng: l.lng }) }))
    .filter((l) => l.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, 10);

  const suggestions = [];
  for (const loc of nearby) {
    const asOrigin = db.prepare(
      `SELECT r.id, r.route_code, o.name as origin_name, d.name as destination_name
       FROM routes r JOIN locations o ON o.id = r.origin_location_id JOIN locations d ON d.id = r.destination_location_id
       WHERE r.origin_location_id = ? AND r.is_cancelled = 0`
    ).all(loc.id).map((r) => ({ ...r, role: 'origin' }));

    const asDest = db.prepare(
      `SELECT r.id, r.route_code, o.name as origin_name, d.name as destination_name
       FROM routes r JOIN locations o ON o.id = r.origin_location_id JOIN locations d ON d.id = r.destination_location_id
       WHERE r.destination_location_id = ? AND r.is_cancelled = 0`
    ).all(loc.id).map((r) => ({ ...r, role: 'destination' }));

    const asStop = db.prepare(
      `SELECT r.id, r.route_code, o.name as origin_name, d.name as destination_name
       FROM route_stops rs
       JOIN routes r ON r.id = rs.route_id
       JOIN locations o ON o.id = r.origin_location_id
       JOIN locations d ON d.id = r.destination_location_id
       WHERE rs.location_id = ? AND r.is_cancelled = 0`
    ).all(loc.id).map((r) => ({ ...r, role: 'stop' }));

    const routes = [...asOrigin, ...asDest, ...asStop];
    if (routes.length > 0) {
      suggestions.push({
        location: { id: loc.id, name: loc.name, lat: loc.lat, lng: loc.lng },
        distanceM: Math.round(loc.distanceM),
        routes,
      });
    }
  }

  res.json({ suggestions });
});

module.exports = router;