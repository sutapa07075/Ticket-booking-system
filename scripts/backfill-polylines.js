// scripts/backfill-polylines.js
require('dotenv').config();
const db = require('../src/db/init');
const googleMaps = require('../src/services/googleMaps.service');

(async () => {
  console.log('[backfill] starting...');

  const routes = db.prepare(`
    SELECT r.id, r.origin_location_id, r.destination_location_id,
           o.lat AS olat, o.lng AS olng, d.lat AS dlat, d.lng AS dlng,
           o.name AS oname, d.name AS dname
    FROM routes r
    JOIN locations o ON o.id = r.origin_location_id
    JOIN locations d ON d.id = r.destination_location_id
    WHERE (r.polyline IS NULL OR r.polyline = '')
      AND o.lat IS NOT NULL AND o.lng IS NOT NULL
      AND d.lat IS NOT NULL AND d.lng IS NOT NULL
  `).all();

  console.log(`[backfill] found ${routes.length} routes to backfill`);

  if (routes.length === 0) {
    // Diagnose why
    const total = db.prepare(`SELECT COUNT(*) c FROM routes`).get().c;
    const missingCoords = db.prepare(`
      SELECT r.id, o.name AS oname, o.lat AS olat, o.lng AS olng,
             d.name AS dname, d.lat AS dlat, d.lng AS dlng
      FROM routes r
      JOIN locations o ON o.id = r.origin_location_id
      JOIN locations d ON d.id = r.destination_location_id
      WHERE o.lat IS NULL OR o.lng IS NULL OR d.lat IS NULL OR d.lng IS NULL
    `).all();
    console.log(`[backfill] ${total} total routes`);
    console.log(`[backfill] routes with missing coords:`, missingCoords);
    process.exit(0);
  }

  for (const r of routes) {
    try {
      console.log(`[backfill] fetching ${r.oname} → ${r.dname}...`);
      const res = await googleMaps.computeRoute(
        { lat: r.olat, lng: r.olng },
        { lat: r.dlat, lng: r.dlng }
      );
      if (res && res.encoded_polyline) {
        db.prepare(`UPDATE routes SET polyline = ?, polyline_length_m = ? WHERE id = ?`)
          .run(res.encoded_polyline, (res.distance_km || 0) * 1000, r.id);
        console.log(`  OK  ${r.id.slice(0, 8)}  ${res.distance_km.toFixed(1)} km`);
      } else {
        console.warn(`  SKIP no polyline for ${r.id} — response:`, res);
      }
    } catch (e) {
      console.warn(`  FAIL ${r.id}:`, e.message);
    }
  }

  console.log('[backfill] done.');
  process.exit(0);
})();