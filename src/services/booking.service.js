const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const seatLock = require('./seatLock.service');
const razorpay = require('./razorpay.service');

/**
 * Core booking logic shared by the website AND partner-company API,
 * so double-booking prevention and refund policy are enforced identically
 * no matter which channel the booking came through.
 */

function getSeatMap(tripId) {
  const trip = db.prepare(`SELECT * FROM trips WHERE id = ?`).get(tripId);
  if (!trip) return null;

  const seats = db.prepare(`SELECT * FROM bus_seats WHERE bus_id = ?`).all(trip.bus_id);
  const bookedSeatIds = new Set(
    db.prepare(`SELECT seat_id FROM booking_seats WHERE trip_id = ?`).all(tripId).map((r) => r.seat_id)
  );

  return {
    trip,
    seats: seats.map((s) => ({ ...s, booked: bookedSeatIds.has(s.id) })),
  };
}

/**
 * Step 1: hold seats (Redis lock) + create a pending booking + Razorpay order.
 * source: 'web' or `partner:<partnerId>`
 */
async function initiateBooking({ userId, tripId, seatIds, boardingStopId, droppingStopId, source }) {
  const trip = db.prepare(`SELECT * FROM trips WHERE id = ?`).get(tripId);
  if (!trip) throw Object.assign(new Error('Trip not found'), { status: 404 });
  if (trip.status === 'cancelled') throw Object.assign(new Error('Trip cancelled'), { status: 409 });

  // Reject seats already permanently booked in DB (fast pre-check before locking)
  const already = db
    .prepare(
      `SELECT seat_id FROM booking_seats WHERE trip_id = ? AND seat_id IN (${seatIds.map(() => '?').join(',')})`
    )
    .all(tripId, ...seatIds);
  if (already.length > 0) {
    throw Object.assign(new Error('Some seats are already booked'), { status: 409, seats: already });
  }

  const holderId = uuidv4();
  const lockResult = await seatLock.lockSeats(tripId, seatIds, holderId);
  if (!lockResult.success) {
    throw Object.assign(new Error('Seats just got taken by someone else'), {
      status: 409,
      conflictSeats: lockResult.conflictSeats,
    });
  }

  const totalAmount = trip.current_price * seatIds.length;
  const bookingId = uuidv4();

  db.prepare(
    `INSERT INTO bookings (id, user_id, trip_id, boarding_stop_id, dropping_stop_id, status, total_amount, source)
     VALUES (?, ?, ?, ?, ?, 'pending_payment', ?, ?)`
  ).run(bookingId, userId, tripId, boardingStopId, droppingStopId, totalAmount, source || 'web');

  const order = await razorpay.createOrder(totalAmount, bookingId);

  db.prepare(
    `INSERT INTO payments (id, booking_id, razorpay_order_id, amount, status) VALUES (?, ?, ?, ?, 'created')`
  ).run(uuidv4(), bookingId, order.id, totalAmount);

  return { bookingId, holderId, seatIds, totalAmount, razorpayOrder: order };
}

/**
 * Step 2: after client confirms payment with Razorpay, verify signature,
 * convert the Redis hold into a permanent booking_seats row (DB UNIQUE
 * constraint on (trip_id, seat_id) is the final safety net).
 */
async function confirmBooking({ bookingId, holderId, seatIds, razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  const valid = razorpay.verifySignature({
    order_id: razorpay_order_id,
    payment_id: razorpay_payment_id,
    signature: razorpay_signature,
  });
  if (!valid) throw Object.assign(new Error('Payment signature verification failed'), { status: 400 });

  const booking = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(bookingId);
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });

  const trip = db.prepare(`SELECT * FROM trips WHERE id = ?`).get(booking.trip_id);

  const insertSeat = db.prepare(
    `INSERT INTO booking_seats (id, booking_id, trip_id, seat_id, price) VALUES (?, ?, ?, ?, ?)`
  );

  const tx = db.transaction((seats) => {
    for (const seatId of seats) {
      // UNIQUE(trip_id, seat_id) throws if somehow already booked -> guarantees no double-booking
      insertSeat.run(uuidv4(), bookingId, booking.trip_id, seatId, trip.current_price);
    }
    db.prepare(`UPDATE bookings SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`).run(bookingId);
    db.prepare(
      `UPDATE payments SET razorpay_payment_id = ?, razorpay_signature = ?, status = 'paid' WHERE booking_id = ?`
    ).run(razorpay_payment_id, razorpay_signature, bookingId);
  });

  try {
    tx(seatIds);
  } catch (e) {
    // Someone else's booking hit the UNIQUE constraint first -> refund immediately.
    db.prepare(`UPDATE bookings SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(bookingId);
    throw Object.assign(new Error('Seat conflict at final confirmation — refund will be issued'), { status: 409 });
  } finally {
    await seatLock.releaseSeats(booking.trip_id, seatIds, holderId);
  }

  return { bookingId, status: 'confirmed' };
}

/**
 * Cancellation with 75% refund policy.
 */
async function cancelBooking(bookingId) {
  const booking = db.prepare(`SELECT * FROM bookings WHERE id = ?`).get(bookingId);
  if (!booking) throw Object.assign(new Error('Booking not found'), { status: 404 });
  if (booking.status !== 'confirmed') {
    throw Object.assign(new Error('Only confirmed bookings can be cancelled'), { status: 400 });
  }

  const payment = db.prepare(`SELECT * FROM payments WHERE booking_id = ? AND status = 'paid'`).get(bookingId);
  if (!payment) throw Object.assign(new Error('No successful payment found for this booking'), { status: 400 });

  const { refundAmountRupees } = await razorpay.refundBooking(payment.razorpay_payment_id, payment.amount);

  db.prepare(
    `UPDATE bookings SET status = 'cancelled', refund_amount = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(refundAmountRupees, bookingId);
  db.prepare(`UPDATE payments SET status = 'refunded' WHERE booking_id = ?`).run(bookingId);
  db.prepare(`DELETE FROM booking_seats WHERE booking_id = ?`).run(bookingId);

  return { bookingId, refundAmount: refundAmountRupees, refundPercent: 75 };
}

module.exports = { getSeatMap, initiateBooking, confirmBooking, cancelBooking };
