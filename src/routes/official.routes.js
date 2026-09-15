const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const { requireOfficial, requireSuperAdmin } = require('../middleware/auth');
const apiSetu = require('../services/apiSetu.service');
const storage = require('../services/storage.service');
const otpService = require('../services/otp.service');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Wraps an async handler so any thrown error (DB constraint, network error,
// etc.) becomes a clean JSON error response instead of crashing the whole
// server. Every route below uses this — no more "SqliteError ... process
// exiting" from a single bad request.
function safe(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`[official.routes] ${req.method} ${req.originalUrl}:`, e.message);

      // Friendly messages for the most common, predictable failure: duplicates.
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || e.code === 'SQLITE_CONSTRAINT') {
        const field = /drivers\.phone/.test(e.message) ? 'A driver with this phone number'
          : /buses\.registration_number/.test(e.message) ? 'A bus with this registration number'
          : /users\.phone/.test(e.message) ? 'A user with this phone number'
          : 'This record';
        return res.status(409).json({ error: `${field} is already registered.` });
      }

      res.status(e.status || 500).json({ error: e.message || 'Something went wrong' });
    }
  };
}

/* ---------- Bootstrap: create the first super admin + region ---------- */
router.post('/bootstrap', safe(async (req, res) => {
  const { setup_key, region_code, region_name, admin_name, admin_phone, admin_access_key } = req.body;
  if (setup_key !== process.env.SUPER_ADMIN_SETUP_KEY) {
    return res.status(403).json({ error: 'Invalid setup key' });
  }
  if (!region_code || !region_name || !admin_name || !admin_phone || !admin_access_key) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const regionId = uuidv4();
  db.prepare(`INSERT INTO regions (id, region_code, name) VALUES (?, ?, ?)`).run(regionId, region_code, region_name);

  const officialId = uuidv4();
  db.prepare(
    `INSERT INTO officials (id, phone, name, security_access_key_hash, region_id, role)
     VALUES (?, ?, ?, ?, ?, 'super_admin')`
  ).run(officialId, admin_phone, admin_name, await bcrypt.hash(admin_access_key, 10), regionId);

  res.status(201).json({ message: 'Super admin + region created', regionId, officialId });
}));

/* ---------- Regions & regional officials (super admin only) ---------- */

router.post('/regions', requireSuperAdmin, safe(async (req, res) => {
  const { region_code, name } = req.body;
  if (!region_code || !name) return res.status(400).json({ error: 'region_code and name required' });
  const id = uuidv4();
  db.prepare(`INSERT INTO regions (id, region_code, name) VALUES (?, ?, ?)`).run(id, region_code, name);
  res.status(201).json({ id, region_code, name });
}));

router.post('/officials', requireSuperAdmin, safe(async (req, res) => {
  const { phone, name, region_id, security_access_key, role } = req.body;
  if (!phone || !name || !region_id || !security_access_key) {
    return res.status(400).json({ error: 'phone, name, region_id, security_access_key required' });
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO officials (id, phone, name, security_access_key_hash, region_id, role)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, phone, name, await bcrypt.hash(security_access_key, 10), region_id, role || 'regional_officer');
  res.status(201).json({ id, message: 'Official created — share the security access key with them securely (out of band).' });
}));

/* ---------- Driver registration + KYC (region-scoped) ---------- */

router.post(
  '/drivers',
  requireOfficial,
  upload.fields([{ name: 'pan_image' }, { name: 'aadhaar_image' }, { name: 'selfie_image' }]),
  safe(async (req, res) => {
    const { name, phone, pan_number, aadhaar_number } = req.body;
    if (!name || !phone || !pan_number || !aadhaar_number) {
      return res.status(400).json({ error: 'name, phone, pan_number, aadhaar_number required' });
    }

    // Friendly pre-check before we even touch file storage, so a duplicate
    // phone fails fast with a clear message instead of a raw DB error.
    const existing = db.prepare(`SELECT id, kyc_status FROM drivers WHERE phone = ?`).get(phone);
    if (existing) {
      return res.status(409).json({
        error: `A driver with phone ${phone} is already registered (driver ID: ${existing.id}, KYC status: ${existing.kyc_status}). Use that ID to assign them to a bus instead of registering again.`,
        existingDriverId: existing.id,
      });
    }

    const files = req.files || {};
    const uploadIfPresent = async (f) => {
      if (!f) return null;
      try {
        return await storage.uploadFile(f[0].buffer, f[0].originalname, f[0].mimetype);
      } catch (e) {
        console.warn('[storage] upload failed, continuing without it:', e.message);
        return null; // Backblaze not configured yet — don't block driver registration on it
      }
    };

    const panKey = await uploadIfPresent(files.pan_image);
    const aadhaarKey = await uploadIfPresent(files.aadhaar_image);
    const selfieKey = await uploadIfPresent(files.selfie_image);

    const driverId = uuidv4();
    db.prepare(
      `INSERT INTO drivers
        (id, name, phone, pan_number, aadhaar_number, pan_image_key, aadhaar_image_key, selfie_image_key,
         registered_by_official_id, region_id, kyc_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(driverId, name, phone, pan_number, aadhaar_number, panKey, aadhaarKey, selfieKey, req.official.id, req.official.regionId);

    let panResult = { verified: false }, aadhaarResult = { verified: false }, faceMatch = { matched: null };
    try {
      [panResult, aadhaarResult] = await Promise.all([
        apiSetu.verifyPan(pan_number, name),
        apiSetu.verifyAadhaar(aadhaar_number),
      ]);
      faceMatch = panKey && aadhaarKey ? await apiSetu.faceMatch(panKey, aadhaarKey) : { matched: null };
    } catch (e) {
      console.warn('[apisetu] verification unavailable, marking pending:', e.message);
    }

    // API Setu sandbox not configured/reachable yet -> stay 'pending' rather than
    // falsely marking 'rejected', so an official can retry or manually approve later.
    const kycStatus = (panResult.verified && aadhaarResult.verified) ? 'verified'
      : (panResult.error || aadhaarResult.error) ? 'pending'
      : 'rejected';

    db.prepare(`UPDATE drivers SET kyc_status = ? WHERE id = ?`).run(kycStatus, driverId);
    if (kycStatus !== 'pending') {
      db.prepare(`UPDATE drivers SET kyc_verified_at = datetime('now') WHERE id = ?`).run(driverId);
    }

    try { await otpService.sendOtp(phone, 'login'); } catch (e) { /* non-fatal */ }

    res.status(201).json({
      driverId,
      kyc_status: kycStatus,
      pan_verified: panResult.verified,
      aadhaar_verified: aadhaarResult.verified,
      face_match: faceMatch,
      note: kycStatus === 'pending' ? 'API Setu sandbox is not configured/reachable — KYC left as pending, not auto-rejected.' : undefined,
    });
  })
);

/* ---------- Bus registration (region-scoped) ---------- */

router.post('/buses', requireOfficial, safe(async (req, res) => {
  const { registration_number, operator_name, bus_type, total_seats, amenities, driver_ids, seat_layout } = req.body;
  if (!registration_number || !total_seats) {
    return res.status(400).json({ error: 'registration_number and total_seats required' });
  }

  const busId = uuidv4();
  db.prepare(
    `INSERT INTO buses (id, registration_number, operator_name, bus_type, total_seats, amenities, region_id, registered_by_official_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(busId, registration_number, operator_name, bus_type || 'seater', total_seats, JSON.stringify(amenities || []), req.official.regionId, req.official.id);

  const layout = seat_layout || Array.from({ length: total_seats }, (_, i) => ({ seat_number: `A${i + 1}`, seat_type: 'seater' }));
  const insertSeat = db.prepare(`INSERT INTO bus_seats (id, bus_id, seat_number, seat_type, deck) VALUES (?, ?, ?, ?, ?)`);
  for (const s of layout) insertSeat.run(uuidv4(), busId, s.seat_number, s.seat_type || 'seater', s.deck || 'lower');

  if (Array.isArray(driver_ids)) {
    const insertBd = db.prepare(`INSERT INTO bus_drivers (id, bus_id, driver_id) VALUES (?, ?, ?)`);
    for (const did of driver_ids) {
      const driver = db.prepare(`SELECT * FROM drivers WHERE id = ? AND region_id = ?`).get(did, req.official.regionId);
      if (driver && driver.kyc_status === 'verified') insertBd.run(uuidv4(), busId, did);
    }
  }

  res.status(201).json({ busId, message: 'Bus registered' });
}));

/* ---------- Route creation, schedule, and cancellation (region-scoped) ---------- */

router.post('/routes', requireOfficial, safe(async (req, res) => {
  const { origin_location_id, destination_location_id, distance_km, base_duration_min, stops, schedule, route_code } = req.body;
  if (!origin_location_id || !destination_location_id) {
    return res.status(400).json({ error: 'origin_location_id and destination_location_id required' });
  }

  const routeId = uuidv4();
  db.prepare(
    `INSERT INTO routes (id, route_code, origin_location_id, destination_location_id, distance_km, base_duration_min, region_id, created_by_official_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(routeId, route_code || null, origin_location_id, destination_location_id, distance_km, base_duration_min, req.official.regionId, req.official.id);

  if (Array.isArray(stops)) {
    const insertStop = db.prepare(`INSERT INTO route_stops (id, route_id, location_id, stop_order, eta_offset_min) VALUES (?, ?, ?, ?, ?)`);
    stops.forEach((s, idx) => insertStop.run(uuidv4(), routeId, s.location_id, idx + 1, s.eta_offset_min || null));
  }

  if (Array.isArray(schedule)) {
    const insertSched = db.prepare(`INSERT INTO route_schedule (id, route_id, days_of_week, departure_time) VALUES (?, ?, ?, ?)`);
    schedule.forEach((s) => insertSched.run(uuidv4(), routeId, s.days_of_week, s.departure_time));
  }

  res.status(201).json({ routeId, message: 'Route created' });
}));

router.post('/routes/:routeId/cancel', requireOfficial, safe(async (req, res) => {
  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(req.params.routeId);
  if (!route) return res.status(404).json({ error: 'Route not found' });
  if (route.region_id !== req.official.regionId) {
    return res.status(403).json({ error: 'You can only manage routes in your own region' });
  }

  db.prepare(
    `UPDATE routes SET is_cancelled = 1, cancelled_by_official_id = ?, cancelled_reason = ? WHERE id = ?`
  ).run(req.official.id, req.body.reason || null, req.params.routeId);

  db.prepare(`UPDATE trips SET status = 'cancelled' WHERE route_id = ? AND status IN ('scheduled','live')`).run(req.params.routeId);

  res.json({ message: 'Route (and its scheduled trips) cancelled' });
}));

/* ---------- Create a trip: a specific bus running a route on a specific date ---------- */

router.post('/trips', requireOfficial, safe(async (req, res) => {
  const { route_id, bus_id, driver_id, travel_date, departure_time, base_price } = req.body;
  if (!route_id || !bus_id || !travel_date || !departure_time || !base_price) {
    return res.status(400).json({ error: 'route_id, bus_id, travel_date, departure_time, base_price required' });
  }

  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(route_id);
  const bus = db.prepare(`SELECT * FROM buses WHERE id = ?`).get(bus_id);

  if (!route) return res.status(404).json({ error: `No route found with ID "${route_id}". Pick one from the Routes list below.` });
  if (route.region_id !== req.official.regionId) return res.status(403).json({ error: 'Route not in your region' });
  if (!bus) return res.status(404).json({ error: `No bus found with ID "${bus_id}". Pick one from the Buses list below.` });
  if (bus.region_id !== req.official.regionId) return res.status(403).json({ error: 'Bus not in your region' });

  const tripId = uuidv4();
  db.prepare(
    `INSERT INTO trips (id, route_id, bus_id, driver_id, travel_date, departure_time, base_price, current_price)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tripId, route_id, bus_id, driver_id || null, travel_date, departure_time, base_price, base_price);

  res.status(201).json({ tripId });
}));

/* ---------- Manual KYC override ----------
   For when API Setu isn't reachable (no real sandbox credentials) or an
   official just needs to correct an automated result. Lets an official
   directly set a driver's KYC status instead of being stuck at "rejected"
   forever with no way to proceed and test the rest of the app. */
router.post('/drivers/:driverId/kyc-override', requireOfficial, safe(async (req, res) => {
  const { status, note } = req.body;
  if (!['verified', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: "status must be 'verified', 'rejected', or 'pending'" });
  }
  const driver = db.prepare(`SELECT * FROM drivers WHERE id = ?`).get(req.params.driverId);
  if (!driver) return res.status(404).json({ error: 'Driver not found' });
  if (driver.region_id !== req.official.regionId) {
    return res.status(403).json({ error: 'You can only manage drivers in your own region' });
  }

  db.prepare(
    `UPDATE drivers SET kyc_status = ?, kyc_verified_at = datetime('now') WHERE id = ?`
  ).run(status, req.params.driverId);

  res.json({ message: `Driver KYC manually set to '${status}'${note ? ` (${note})` : ''}` });
}));

/* ---------- LIST endpoints: so IDs never have to be memorized/copy-pasted blind ----------
   All scoped to the logged-in official's own region. Used by the dashboard's
   "My region" tab and by dropdown pickers on the bus/trip forms. */

router.get('/drivers', requireOfficial, safe(async (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, phone, kyc_status, created_at FROM drivers WHERE region_id = ? ORDER BY created_at DESC`
  ).all(req.official.regionId);
  res.json({ drivers: rows });
}));

router.get('/buses', requireOfficial, safe(async (req, res) => {
  const rows = db.prepare(
    `SELECT id, registration_number, operator_name, bus_type, total_seats, is_active, created_at FROM buses WHERE region_id = ? ORDER BY created_at DESC`
  ).all(req.official.regionId);
  res.json({ buses: rows });
}));

router.get('/routes', requireOfficial, safe(async (req, res) => {
  const rows = db.prepare(
    `SELECT r.id, r.route_code, r.distance_km, r.is_cancelled, r.created_at,
            o.name as origin_name, d.name as destination_name
     FROM routes r
     JOIN locations o ON o.id = r.origin_location_id
     JOIN locations d ON d.id = r.destination_location_id
     WHERE r.region_id = ? ORDER BY r.created_at DESC`
  ).all(req.official.regionId);
  res.json({ routes: rows });
}));

router.get('/trips', requireOfficial, safe(async (req, res) => {
  const rows = db.prepare(
    `SELECT t.id, t.travel_date, t.departure_time, t.status, t.base_price, t.current_price,
            bus.registration_number, o.name as origin_name, d.name as destination_name
     FROM trips t
     JOIN buses bus ON bus.id = t.bus_id
     JOIN routes r ON r.id = t.route_id
     JOIN locations o ON o.id = r.origin_location_id
     JOIN locations d ON d.id = r.destination_location_id
     WHERE r.region_id = ?
     ORDER BY t.travel_date DESC, t.departure_time DESC`
  ).all(req.official.regionId);
  res.json({ trips: rows });
}));

module.exports = router;
