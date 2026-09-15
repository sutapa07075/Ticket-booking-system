const express = require('express');
const db = require('../db/init');
const routeSearch = require('../services/routeSearch.service');

const router = express.Router();

// GET /api/journey/search?origin=locId&destination=locId&date=YYYY-MM-DD
router.get('/search', (req, res) => {
  const { origin, destination, date } = req.query;
  if (!origin || !destination || !date) {
    return res.status(400).json({ error: 'origin, destination, date are required' });
  }

  const { direct, connecting } = routeSearch.search(origin, destination);

  const dayName = new Date(date).toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(); // MON..SUN

  function tripsForRoute(routeId) {
    const schedules = db
      .prepare(`SELECT * FROM route_schedule WHERE route_id = ?`)
      .all(routeId)
      .filter((s) => s.days_of_week.split(',').includes(dayName));

    if (schedules.length === 0) return [];

    return db
      .prepare(
        `SELECT t.*, b.registration_number, b.bus_type, b.total_seats, b.operator_name
         FROM trips t JOIN buses b ON b.id = t.bus_id
         WHERE t.route_id = ? AND t.travel_date = ? AND t.status != 'cancelled'`
      )
      .all(routeId, date);
  }

  const directResults = direct.map((d) => ({
    ...d,
    trips: tripsForRoute(d.route.id),
  }));

  const connectingResults = connecting.map((c) => ({
    ...c,
    legs: c.legs.map((leg) => ({ ...leg, trips: tripsForRoute(leg.route.id) })),
  }));

  res.json({
    direct: directResults,
    connecting: connectingResults,
    note:
      connectingResults.length > 0
        ? 'No direct route found — showing suggested bus-change (connecting) options.'
        : undefined,
  });
});

module.exports = router;
