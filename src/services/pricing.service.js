const axios = require('axios');
const db = require('../db/init');
const { v4: uuidv4 } = require('uuid');

/**
 * Dynamic pricing model.
 * Final price = basePrice * combinedMultiplier, clamped to [MIN_MULT, MAX_MULT]
 * so customers never see wild, unfair swings, and we never sell below cost.
 *
 * Factors (each returns a multiplier centered at 1.0):
 *  - demandFactor: how full the trip is (occupancy)
 *  - calendarFactor: weekend / holiday / vacation period
 *  - weatherFactor: bad weather at origin -> slight surge (more demand for safe travel)
 *  - fuelFactor: current fuel price index vs baseline
 *  - lastMinuteDiscount: if seats still empty close to departure, discount to fill bus
 */

const MIN_MULT = 0.7;   // never below 70% of base (protects margins)
const MAX_MULT = 1.6;   // never above 160% of base (keeps customers happy)

async function demandFactor(tripId, totalSeats) {
  const booked = db
    .prepare(`SELECT COUNT(*) c FROM booking_seats WHERE trip_id = ?`)
    .get(tripId).c;
  const occupancy = totalSeats > 0 ? booked / totalSeats : 0;

  // Low occupancy -> mild discount to attract bookings.
  // High occupancy -> surge, because demand is proven.
  if (occupancy < 0.3) return 0.92;
  if (occupancy < 0.6) return 1.0;
  if (occupancy < 0.85) return 1.15;
  return 1.3; // almost full -> premium for last remaining seats
}

function calendarFactor(travelDate) {
  const d = new Date(travelDate);
  const day = d.getDay(); // 0 Sun, 6 Sat
  let mult = 1.0;
  if (day === 0 || day === 5 || day === 6) mult *= 1.12; // Fri/Sat/Sun weekend bump

  // Simple vacation-period heuristic (extend with a real holiday-calendar API)
  const month = d.getMonth() + 1;
  const vacationMonths = [5, 6, 12]; // May-June summer break, December
  if (vacationMonths.includes(month)) mult *= 1.08;

  return mult;
}

async function weatherFactor(originLat, originLng) {
  try {
    if (!process.env.GOOGLE_MAPS_API_KEY) return 1.0;
    // Using a generic weather API (swap for your provider); kept optional/best-effort.
    // If not configured, factor defaults to neutral.
    return 1.0; // placeholder: wire up e.g. OpenWeather here with lat/lng
  } catch {
    return 1.0;
  }
}

async function fuelFactor() {
  // Placeholder for a real fuel-price index feed. Neutral by default.
  // In production: fetch daily diesel price, compare to a baseline, e.g.
  //   multiplier = clamp(currentPrice / baselinePrice, 0.95, 1.15)
  return 1.0;
}

function lastMinuteDiscount(departureDateTime) {
  const hoursLeft = (new Date(departureDateTime) - new Date()) / (1000 * 60 * 60);
  // Discount window: within 3 hours of departure, if seats remain unsold, drop price
  // to fill the bus rather than run empty (better than zero revenue).
  if (hoursLeft > 0 && hoursLeft < 3) return 0.85;
  return 1.0;
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

/**
 * Recompute and persist the current price for one trip.
 */
async function recalculateTripPrice(trip) {
  const bus = db.prepare(`SELECT * FROM buses WHERE id = ?`).get(trip.bus_id);
  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(trip.route_id);
  const origin = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(route.origin_location_id);

  const dep = `${trip.travel_date}T${trip.departure_time}:00`;

  const [demand, weather, fuel] = await Promise.all([
    demandFactor(trip.id, bus.total_seats),
    weatherFactor(origin?.lat, origin?.lng),
    fuelFactor(),
  ]);
  const calendar = calendarFactor(trip.travel_date);
  const lastMin = lastMinuteDiscount(dep);

  let combined = demand * calendar * weather * fuel * lastMin;
  combined = clamp(combined, MIN_MULT, MAX_MULT);

  const newPrice = Math.round(trip.base_price * combined);

  db.prepare(
    `UPDATE trips SET current_price = ?, last_price_update = datetime('now') WHERE id = ?`
  ).run(newPrice, trip.id);

  db.prepare(
    `INSERT INTO trip_price_history (id, trip_id, price, factors_json) VALUES (?, ?, ?, ?)`
  ).run(
    uuidv4(),
    trip.id,
    newPrice,
    JSON.stringify({ demand, calendar, weather, fuel, lastMin, combined })
  );

  return newPrice;
}

/**
 * Recalculate all upcoming trips - call this on a cron every 30 minutes.
 */
async function recalculateAllUpcomingTrips() {
  const trips = db
    .prepare(`SELECT * FROM trips WHERE status IN ('scheduled','live') AND travel_date >= date('now')`)
    .all();

  for (const trip of trips) {
    try {
      await recalculateTripPrice(trip);
    } catch (e) {
      console.error(`[pricing] failed for trip ${trip.id}:`, e.message);
    }
  }
  return trips.length;
}

module.exports = { recalculateTripPrice, recalculateAllUpcomingTrips };
