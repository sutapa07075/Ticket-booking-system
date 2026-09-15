const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const maps = require('../services/googleMaps.service');

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

module.exports = router;
