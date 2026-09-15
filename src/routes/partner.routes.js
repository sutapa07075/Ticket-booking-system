const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const { requirePartnerAuth } = require('../middleware/apiPartnerAuth');
const { requireSuperAdmin } = require('../middleware/auth');
const bookingService = require('../services/booking.service');

const router = express.Router();

/**
 * A company applies to become an API partner. They land in 'pending_review'
 * status and CANNOT call booking endpoints until an official (super_admin)
 * verifies their business details (GSTIN/CIN, uploaded proof-of-business doc)
 * and approves them.
 */
router.post('/apply', (req, res) => {
  const { company_name, contact_email, contact_phone, gstin, cin, business_doc_key } = req.body;
  if (!company_name || !contact_email || !gstin) {
    return res.status(400).json({ error: 'company_name, contact_email, gstin are required' });
  }

  const rawKey = crypto.randomBytes(24).toString('hex');
  const rawSecret = crypto.randomBytes(32).toString('hex');

  const id = uuidv4();
  db.prepare(
    `INSERT INTO api_partners
      (id, company_name, contact_email, contact_phone, gstin, cin, business_doc_key, api_key_hash, api_secret_hash, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review')`
  ).run(
    id,
    company_name,
    contact_email,
    contact_phone,
    gstin,
    cin,
    business_doc_key,
    bcrypt.hashSync(rawKey, 10),
    bcrypt.hashSync(rawSecret, 10)
  );

  // Show the key/secret ONCE. Store them securely - they cannot be recovered later.
  res.status(201).json({
    message: 'Application submitted. Your credentials are shown once — store them securely. They will only work after our team approves your account.',
    partner_id: id,
    api_key: rawKey,
    api_secret: rawSecret,
    status: 'pending_review',
  });
});

/**
 * Super admin (official) approves/rejects a partner after checking their
 * business documents / GSTIN / CIN manually (or via a company-registry API).
 */
router.post('/:partnerId/review', requireSuperAdmin, (req, res) => {
  const { decision, rate_limit_per_min } = req.body; // 'approved' | 'rejected'
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: "decision must be 'approved' or 'rejected'" });
  }
  db.prepare(
    `UPDATE api_partners SET status = ?, approved_by_official_id = ?, rate_limit_per_min = COALESCE(?, rate_limit_per_min) WHERE id = ?`
  ).run(decision, req.official.id, rate_limit_per_min || null, req.partnerId || req.params.partnerId);
  res.json({ message: `Partner ${decision}` });
});

/* ---------------- Booking endpoints for approved partners ---------------- */
// These reuse the exact same booking.service functions the website uses,
// so the seat-lock/UNIQUE-constraint double-booking prevention is shared.

router.get('/trip/:tripId/seats', requirePartnerAuth, (req, res) => {
  const map = bookingService.getSeatMap(req.params.tripId);
  if (!map) return res.status(404).json({ error: 'Trip not found' });
  res.json(map);
});

router.post('/booking/initiate', requirePartnerAuth, async (req, res) => {
  const { userPhone, tripId, seatIds, boardingStopId, droppingStopId } = req.body;
  if (!userPhone || !tripId || !Array.isArray(seatIds) || seatIds.length === 0) {
    return res.status(400).json({ error: 'userPhone, tripId, seatIds[] required' });
  }

  let user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(userPhone);
  if (!user) {
    const id = uuidv4();
    db.prepare(`INSERT INTO users (id, phone) VALUES (?, ?)`).run(id, userPhone);
    user = { id, phone: userPhone };
  }

  try {
    const result = await bookingService.initiateBooking({
      userId: user.id,
      tripId,
      seatIds,
      boardingStopId,
      droppingStopId,
      source: `partner:${req.partner.id}`,
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/booking/confirm', requirePartnerAuth, async (req, res) => {
  try {
    const result = await bookingService.confirmBooking(req.body);
    res.json(result);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
