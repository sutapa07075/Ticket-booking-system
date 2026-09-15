const redis = require('../config/redis');

/**
 * Prevents double-booking of the SAME seat on the SAME trip, whether the
 * request comes from our own website or from a partner company's API.
 * Every booking channel MUST go through this before writing to the DB.
 *
 * Strategy: a short-lived Redis lock per seat, acquired atomically with
 * SET key value NX PX <ttl>. Only the holder can confirm the booking;
 * the lock is released on success (converted into a permanent DB row)
 * or expires automatically if the user abandons checkout.
 */

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 min hold while user pays

function seatKey(tripId, seatId) {
  return `seatlock:${tripId}:${seatId}`;
}

/**
 * Try to lock a set of seats for one holder (booking attempt).
 * Returns { success, lockedSeats, conflictSeats }
 */
async function lockSeats(tripId, seatIds, holderId) {
  const locked = [];
  const conflicts = [];

  for (const seatId of seatIds) {
    const key = seatKey(tripId, seatId);
    // NX = only set if not exists -> atomic per-seat lock
    const result = await redis.set(key, holderId, 'PX', LOCK_TTL_MS, 'NX');
    if (result === 'OK') {
      locked.push(seatId);
    } else {
      conflicts.push(seatId);
    }
  }

  if (conflicts.length > 0) {
    // Roll back any seats we managed to lock, since the whole request must be atomic
    await releaseSeats(tripId, locked, holderId);
    return { success: false, lockedSeats: [], conflictSeats: conflicts };
  }

  return { success: true, lockedSeats: locked, conflictSeats: [] };
}

async function releaseSeats(tripId, seatIds, holderId) {
  for (const seatId of seatIds) {
    const key = seatKey(tripId, seatId);
    const owner = await redis.get(key);
    if (owner === holderId) {
      await redis.del(key);
    }
  }
}

async function isLockedByOther(tripId, seatId, holderId) {
  const owner = await redis.get(seatKey(tripId, seatId));
  return owner && owner !== holderId;
}

module.exports = { lockSeats, releaseSeats, isLockedByOther, LOCK_TTL_MS };
