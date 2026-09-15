const db = require('../db/init');

const DEFAULT_TRIP_DURATION_MIN = 240; // fallback if a route has no base_duration_min set

function timeToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}


function checkBusAvailability({ busId, date, departureTime, durationMin, excludeTripId }) {
  const newStart = timeToMinutes(departureTime);
  const newEnd = newStart + (durationMin || DEFAULT_TRIP_DURATION_MIN);

  const existing = db
    .prepare(
      `SELECT t.id, t.departure_time, t.route_id, r.base_duration_min,
              o.name as origin_name, d.name as destination_name
       FROM trips t
       JOIN routes r ON r.id = t.route_id
       JOIN locations o ON o.id = r.origin_location_id
       JOIN locations d ON d.id = r.destination_location_id
       WHERE t.bus_id = ? AND t.travel_date = ? AND t.status != 'cancelled'`
    )
    .all(busId, date);

  for (const trip of existing) {
    if (excludeTripId && trip.id === excludeTripId) continue;
    const existingStart = timeToMinutes(trip.departure_time);
    const existingEnd = existingStart + (trip.base_duration_min || DEFAULT_TRIP_DURATION_MIN);

    const overlaps = existingStart < newEnd && newStart < existingEnd;
    if (overlaps) {
      return {
        available: false,
        conflictingTrip: {
          id: trip.id,
          route: `${trip.origin_name} → ${trip.destination_name}`,
          departure_time: trip.departure_time,
          estimated_arrival_min_after_departure: trip.base_duration_min || DEFAULT_TRIP_DURATION_MIN,
        },
      };
    }
  }

  return { available: true };
}

module.exports = { checkBusAvailability, DEFAULT_TRIP_DURATION_MIN };
