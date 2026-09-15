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
 *  - weatherFactor: real weather at origin, via Open-Meteo (free, no API key)
 *  - fuelFactor: fuel price index vs a baseline (see fuel_price_index table)
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

/**
 * Real weather factor using Open-Meteo (https://open-meteo.com) — free,
 * no API key required, works worldwide including India. Bad weather (rain,
 * storms, fog, extreme heat) mildly raises price, reflecting real demand for
 * safer/AC travel and genuinely higher operating costs in bad conditions.
 * On any failure (no coordinates, network down, etc), returns neutral (1.0)
 * so pricing never breaks over a weather API hiccup.
 */
async function weatherFactor(lat, lng) {
  if (lat == null || lng == null) return { multiplier: 1.0, detail: 'no coordinates available' };
  try {
    const { data } = await axios.get('https://api.open-meteo.com/v1/forecast', {
      params: { latitude: lat, longitude: lng, current: 'temperature_2m,precipitation,weather_code,wind_speed_10m' },
      timeout: 4000,
    });
    const c = data.current;
    if (!c) return { multiplier: 1.0, detail: 'no current weather returned' };

    let mult = 1.0;
    const notes = [];

    // WMO weather codes: 51-67 = rain/drizzle/freezing rain, 71-77 = snow,
    // 80-82 = rain showers, 95-99 = thunderstorm, 45-48 = fog.
    const code = c.weather_code;
    if ((code >= 95 && code <= 99)) { mult *= 1.12; notes.push('thunderstorm'); }
    else if ((code >= 80 && code <= 82) || (code >= 51 && code <= 67)) { mult *= 1.07; notes.push('rain'); }
    else if (code >= 45 && code <= 48) { mult *= 1.05; notes.push('fog/low visibility'); }
    else if (code >= 71 && code <= 77) { mult *= 1.06; notes.push('snow'); }

    if (c.precipitation > 5) { mult *= 1.03; notes.push('heavy precipitation'); }
    if (c.temperature_2m >= 42) { mult *= 1.03; notes.push('extreme heat'); }
    if (c.wind_speed_10m >= 40) { mult *= 1.02; notes.push('high wind'); }

    return { multiplier: mult, detail: notes.length ? notes.join(', ') : 'clear', raw: c };
  } catch (e) {
    console.warn('[pricing] weather lookup failed, using neutral factor:', e.message);
    return { multiplier: 1.0, detail: 'weather lookup failed' };
  }
}

const BASELINE_FUEL_PRICE = Number(process.env.BASELINE_DIESEL_PRICE_PER_LITER || 92); // ₹/liter, adjust to your region's typical price

/**
 * Fetch current diesel price for a given city from Zyla API Hub.
 * Requires FUEL_API_KEY in .env (Zyla API Hub subscription).
 * Free tier: up to 50 requests.
 */
async function fetchFuelPriceForCity(cityName) {
  const apiKey = process.env.FUEL_API_KEY;
  if (!apiKey) {
    console.warn('[pricing] FUEL_API_KEY not set, cannot fetch real-time fuel price');
    return null;
  }

  try {
    const { data } = await axios.get(
      'https://zylalabs.com/api/13697/indian+fuel+prices+api/31171/latest',
      {
        params: { city: cityName },
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 5000,
      }
    );

    // Response shape per Zyla docs: { status, success, data: { diesel, petrol, ... } }
    const dieselPrice = data?.data?.diesel;
    if (typeof dieselPrice !== 'number' || dieselPrice <= 0) {
      console.warn(`[pricing] fuel API returned no valid diesel price for ${cityName}`);
      return null;
    }

    return {
      price: dieselPrice,
      source: `Zyla API — ${cityName}`,
    };
  } catch (e) {
    console.warn(`[pricing] fuel API lookup failed for ${cityName}:`, e.message);
    return null;
  }
}

/**
 * Fetch and persist the latest fuel price for a specific trip origin.
 * Called during recalculateTripPrice so each trip uses its own city's price.
 */
async function refreshFuelPriceForLocation(originLocation) {
  if (!originLocation?.name) {
    console.warn('[pricing] origin location has no name, cannot fetch city-specific fuel price');
    return null;
  }

  const result = await fetchFuelPriceForCity(originLocation.name);
  if (!result) return null;

  // Persist to fuel_price_index so history is retained
  db.prepare(
    `INSERT INTO fuel_price_index (id, price_per_liter, source) VALUES (?, ?, ?)`
  ).run(uuidv4(), result.price, result.source);

  return result.price;
}

/**
 * Fuel factor compares the latest known diesel price against a baseline.
 * Now uses city-specific real-time price fetched from Zyla API Hub.
 * If no price is available, falls back to last known DB record or neutral 1.0.
 */
async function fuelFactor(originLocation) {
  let priceRow = null;

  // Try to fetch fresh city-specific price
  if (originLocation?.name) {
    const cityPrice = await refreshFuelPriceForLocation(originLocation);
    if (cityPrice != null) {
      priceRow = { price_per_liter: cityPrice, source: `Zyla API — ${originLocation.name}` };
    }
  }

  // Fall back to latest known record in DB
  if (!priceRow) {
    priceRow = db
      .prepare(`SELECT * FROM fuel_price_index ORDER BY created_at DESC LIMIT 1`)
      .get();
  }

  if (!priceRow) {
    return { multiplier: 1.0, detail: 'no fuel price on record yet' };
  }

  const ratio = priceRow.price_per_liter / BASELINE_FUEL_PRICE;
  const multiplier = Math.max(0.95, Math.min(1.15, ratio)); // fuel alone shouldn't swing price wildly
  return {
    multiplier,
    detail: `₹${priceRow.price_per_liter}/L vs baseline ₹${BASELINE_FUEL_PRICE}/L (source: ${priceRow.source})`,
  };
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
    fuelFactor(origin),
  ]);
  const calendar = calendarFactor(trip.travel_date);
  const lastMin = lastMinuteDiscount(dep);

  let combined = demand * calendar * weather.multiplier * fuel.multiplier * lastMin;
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
    JSON.stringify({ demand, calendar, weather: weather.multiplier, weatherDetail: weather.detail, fuel: fuel.multiplier, fuelDetail: fuel.detail, lastMin, combined })
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

module.exports = { recalculateTripPrice, recalculateAllUpcomingTrips, fetchFuelPriceForCity, refreshFuelPriceForLocation, weatherFactor, fuelFactor };