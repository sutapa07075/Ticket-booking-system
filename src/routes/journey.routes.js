const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const routeSearch = require('../services/routeSearch.service');
const busAvailability = require('../services/busAvailability.service');
const pricing = require('../services/pricing.service');

const router = express.Router();

// GET /api/journey/search
//   ?origin=locId&destination=locId&date=YYYY-MM-DD
//   OR ?originLat=..&originLng=..&destLat=..&destLng=..&date=YYYY-MM-DD
router.get('/search', async (req, res) => {
  const {
    origin, destination, date,
    originLat, originLng, destLat, destLng, originName, destName,
  } = req.query;

  if (!date) return res.status(400).json({ error: 'date is required' });

  let originInput, destInput;
  if (originLat && originLng) {
    originInput = { lat: Number(originLat), lng: Number(originLng), name: originName || 'Picked origin' };
  } else if (origin) {
    originInput = { locationId: origin };
  } else {
    return res.status(400).json({ error: 'origin or originLat/originLng required' });
  }

  if (destLat && destLng) {
    destInput = { lat: Number(destLat), lng: Number(destLng), name: destName || 'Picked destination' };
  } else if (destination) {
    destInput = { locationId: destination };
  } else {
    return res.status(400).json({ error: 'destination or destLat/destLng required' });
  }

  let direct, connecting;
  try {
    ({ direct, connecting } = routeSearch.search(originInput, destInput));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  const dayName = new Date(date)
    .toLocaleDateString('en-US', { weekday: 'short' })
    .toUpperCase();

  async function tripsForRoute(routeId) {
    // 1) Explicit trips for this exact date
    let trips = db.prepare(
      `SELECT t.*, b.registration_number, b.bus_type, b.total_seats, b.operator_name
       FROM trips t JOIN buses b ON b.id = t.bus_id
       WHERE t.route_id = ? AND t.travel_date = ? AND t.status != 'cancelled'`
    ).all(routeId, date);
    if (trips.length > 0) return trips;

    // 2) Materialize from recurring schedule
    const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(routeId);
    if (!route || !route.default_bus_id || route.is_cancelled) return [];
    if (new Date(date) < new Date(new Date().toDateString())) return [];

    const schedule = db.prepare(`SELECT * FROM route_schedule WHERE route_id = ?`).all(routeId)
      .find((s) => s.days_of_week.split(',').includes(dayName));
    if (!schedule) return [];

    const bus = db.prepare(`SELECT * FROM buses WHERE id = ? AND is_active = 1`).get(route.default_bus_id);
    if (!bus) return [];

    const availability = busAvailability.checkBusAvailability({
      busId: bus.id, date,
      departureTime: schedule.departure_time,
      durationMin: route.base_duration_min,
    });
    if (!availability.available) return [];

    const driverRow = db.prepare(`SELECT driver_id FROM bus_drivers WHERE bus_id = ? LIMIT 1`).get(bus.id);
    const basePrice = route.default_price || 500;
    const tripId = uuidv4();
    db.prepare(
      `INSERT INTO trips (id, route_id, bus_id, driver_id, travel_date, departure_time, base_price, current_price)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(tripId, routeId, bus.id, driverRow ? driverRow.driver_id : null, date, schedule.departure_time, basePrice, basePrice);

    try {
      const newTrip = db.prepare(`SELECT * FROM trips WHERE id = ?`).get(tripId);
      await pricing.recalculateTripPrice(newTrip);
    } catch (e) {
      console.warn('[journey/search] price calc failed:', e.message);
    }

    return db.prepare(
      `SELECT t.*, b.registration_number, b.bus_type, b.total_seats, b.operator_name
       FROM trips t JOIN buses b ON b.id = t.bus_id WHERE t.id = ?`
    ).all(tripId);
  }

  const directResults = [];
  for (const d of direct) directResults.push({ ...d, trips: await tripsForRoute(d.route.id) });

  const connectingResults = [];
  for (const c of connecting) {
    const legs = [];
    for (const leg of c.legs) legs.push({ ...leg, trips: await tripsForRoute(leg.route.id) });
    connectingResults.push({ ...c, legs });
  }

  res.json({
    direct: directResults,
    connecting: connectingResults,
    note: (directResults.some(d => d.isSubSegment) && connectingResults.length > 0)
      ? 'Some direct options board partway along a longer route — a connecting (bus-change) option is also shown in case it works out better for you.'
      : undefined,
  });
});

module.exports = router;