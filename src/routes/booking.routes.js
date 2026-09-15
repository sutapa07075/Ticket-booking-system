const express = require('express');
const { requireAuth } = require('../middleware/auth');
const bookingService = require('../services/booking.service');

const router = express.Router();

const db = require('../db/init');

router.get('/mine', requireAuth, (req, res) => {
  const rows = db
    .prepare(
      `SELECT b.id as booking_id, b.status, b.total_amount, b.refund_amount, b.created_at,
              t.id as trip_id, t.travel_date, t.departure_time, t.status as trip_status,
              bus.registration_number, bus.operator_name,
              o.name as origin_name, d.name as dest_name
       FROM bookings b
       JOIN trips t ON t.id = b.trip_id
       JOIN buses bus ON bus.id = t.bus_id
       JOIN routes r ON r.id = t.route_id
       JOIN locations o ON o.id = r.origin_location_id
       JOIN locations d ON d.id = r.destination_location_id
       WHERE b.user_id = ?
         AND b.status = 'confirmed'
       ORDER BY b.created_at DESC`
    )
    .all(req.user.id);
  res.json({ bookings: rows });
});

/**
 * Full detail for one confirmed booking: bus number, driver name, route
 * (origin/destination/ordered stops), the trip's seat matrix (who's
 * booked, which seat is this user's), and the bus's current live location
 * if the trip is under way. Everything the "tap a booked ticket" screen needs.
 */
router.get('/:bookingId', requireAuth, (req, res) => {
  const booking = db.prepare(
    `SELECT b.*, t.travel_date, t.departure_time, t.status as trip_status, t.route_id, t.bus_id, t.driver_id,
            bus.registration_number, bus.operator_name, bus.bus_type, bus.total_seats,
            o.name as origin_name, o.lat as origin_lat, o.lng as origin_lng,
            d.name as dest_name, d.lat as dest_lat, d.lng as dest_lng
     FROM bookings b
     JOIN trips t ON t.id = b.trip_id
     JOIN buses bus ON bus.id = t.bus_id
     JOIN routes r ON r.id = t.route_id
     JOIN locations o ON o.id = r.origin_location_id
     JOIN locations d ON d.id = r.destination_location_id
     WHERE b.id = ? AND b.user_id = ?`
  ).get(req.params.bookingId, req.user.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found' });

  const driver = booking.driver_id
    ? db.prepare(`SELECT id, name, phone FROM drivers WHERE id = ?`).get(booking.driver_id)
    : null;

  const stops = db.prepare(
    `SELECT rs.stop_order, rs.eta_offset_min, l.name, l.lat, l.lng
     FROM route_stops rs JOIN locations l ON l.id = rs.location_id
     WHERE rs.route_id = ? ORDER BY rs.stop_order`
  ).all(booking.route_id);

  const mySeatIds = new Set(
    db.prepare(`SELECT seat_id FROM booking_seats WHERE booking_id = ?`).all(booking.id).map((r) => r.seat_id)
  );
  const allSeats = db.prepare(`SELECT * FROM bus_seats WHERE bus_id = ?`).all(booking.bus_id);
  const bookedSeatIds = new Set(
    db.prepare(`SELECT seat_id FROM booking_seats WHERE trip_id = ?`).all(booking.trip_id).map((r) => r.seat_id)
  );
  const seatMatrix = allSeats.map((s) => ({
    ...s,
    booked: bookedSeatIds.has(s.id),
    mine: mySeatIds.has(s.id),
  }));

  const currentLocation = db.prepare(
    `SELECT lat, lng, speed_kmph, heading, recorded_at FROM trip_locations WHERE trip_id = ? ORDER BY recorded_at DESC LIMIT 1`
  ).get(booking.trip_id) || null;

  res.json({
    booking: {
      id: booking.id, status: booking.status, total_amount: booking.total_amount,
      refund_amount: booking.refund_amount, created_at: booking.created_at,
      boarding_name: booking.boarding_name, dropping_name: booking.dropping_name,
    },
    trip: { id: booking.trip_id, travel_date: booking.travel_date, departure_time: booking.departure_time, status: booking.trip_status },
    bus: { registration_number: booking.registration_number, operator_name: booking.operator_name, bus_type: booking.bus_type, total_seats: booking.total_seats },
    driver,
    route: {
      origin: { name: booking.origin_name, lat: booking.origin_lat, lng: booking.origin_lng },
      destination: { name: booking.dest_name, lat: booking.dest_lat, lng: booking.dest_lng },
      stops,
    },
    seatMatrix,
    currentLocation,
  });
});

router.get('/trip/:tripId/seats', (req, res) => {
  const map = bookingService.getSeatMap(req.params.tripId);
  if (!map) return res.status(404).json({ error: 'Trip not found' });
  res.json(map);
});

router.post('/initiate', requireAuth, async (req, res) => {
  const { tripId, seatIds, boardingStopId, droppingStopId } = req.body;
  if (!tripId || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'tripId and non-empty seatIds[] required' });
  }
  try {
    const result = await bookingService.initiateBooking({
      userId: req.user.id,
      tripId,
      seatIds,
      boardingStopId,
      droppingStopId,
      source: 'web',
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message, ...e });
  }
});

router.post('/confirm', requireAuth, async (req, res) => {
  const { bookingId, holderId, seatIds, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  try {
    const result = await bookingService.confirmBooking({
      bookingId,
      holderId,
      seatIds,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

/**
 * Explicit release — called when the user closes the Razorpay modal,
 * clicks cancel, or navigates away before paying. Frees the Redis locks
 * immediately instead of waiting for the 5-minute TTL.
 */
router.post('/release', requireAuth, async (req, res) => {
  const { bookingId, holderId } = req.body;
  if (!bookingId || !holderId) {
    return res.status(400).json({ error: 'bookingId and holderId required' });
  }
  try {
    const result = await bookingService.releaseBooking({ bookingId, holderId });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/:bookingId/cancel', requireAuth, async (req, res) => {
  try {
    const result = await bookingService.cancelBooking(req.params.bookingId);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;