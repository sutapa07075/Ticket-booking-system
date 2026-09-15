const express = require('express');
const db = require('../db/init');
const redis = require('../config/redis');

const router = express.Router();

// Latest known position (fast path via Redis cache)
router.get('/:tripId/latest', async (req, res) => {
  const cached = await redis.get(`live:${req.params.tripId}`);
  if (cached) return res.json(JSON.parse(cached));

  const row = db
    .prepare(`SELECT lat, lng, speed_kmph, heading, recorded_at FROM trip_locations WHERE trip_id = ? ORDER BY recorded_at DESC LIMIT 1`)
    .get(req.params.tripId);
  if (!row) return res.status(404).json({ error: 'No location data yet for this trip' });
  res.json(row);
});

// Full breadcrumb trail (for drawing the travelled path on a map)
router.get('/:tripId/history', (req, res) => {
  const rows = db
    .prepare(`SELECT lat, lng, speed_kmph, heading, recorded_at FROM trip_locations WHERE trip_id = ? ORDER BY recorded_at ASC`)
    .all(req.params.tripId);
  res.json({ points: rows });
});

module.exports = router;
