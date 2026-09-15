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
       ORDER BY b.created_at DESC`
    )
    .all(req.user.id);
  res.json({ bookings: rows });
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

router.post('/:bookingId/cancel', requireAuth, async (req, res) => {
  try {
    const result = await bookingService.cancelBooking(req.params.bookingId);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
