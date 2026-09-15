const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');
const otpService = require('../services/otp.service');
const { sign } = require('../utils/jwt');

const router = express.Router();

/* ---------------- USER: phone + OTP ---------------- */

// Step 1: request OTP (auto-registers phone if new)
router.post('/user/request-otp', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\+?[0-9]{10,15}$/.test(phone)) {
    return res.status(400).json({ error: 'Valid phone number required' });
  }

  let user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
  if (!user) {
    user = { id: uuidv4(), phone };
    db.prepare(`INSERT INTO users (id, phone) VALUES (?, ?)`).run(user.id, phone);
  }

  await otpService.sendOtp(phone, 'login');
  res.json({ message: 'OTP sent', new_user: !user.name });
});

// Step 2: verify OTP -> issue JWT
router.post('/user/verify-otp', async (req, res) => {
  const { phone, otp, name } = req.body;
  if (!phone || !otp) return res.status(400).json({ error: 'phone and otp required' });

  const result = await otpService.verifyOtp(phone, otp, 'login');
  if (!result.valid) return res.status(400).json({ error: `OTP invalid: ${result.reason}` });

  db.prepare(
    `UPDATE users SET is_phone_verified = 1, name = COALESCE(?, name), updated_at = datetime('now') WHERE phone = ?`
  ).run(name || null, phone);

  const user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
  const token = sign({ id: user.id, phone: user.phone, type: 'user' });

  res.json({ token, user: { id: user.id, phone: user.phone, name: user.name } });
});

/* ---------------- OFFICIAL: phone + OTP + security access key ---------------- */

router.post('/official/request-otp', async (req, res) => {
  const { phone } = req.body;
  const official = db.prepare(`SELECT * FROM officials WHERE phone = ? AND is_active = 1`).get(phone);
  if (!official) return res.status(404).json({ error: 'No active official account for this phone' });

  await otpService.sendOtp(phone, 'official_login');
  res.json({ message: 'OTP sent' });
});

router.post('/official/verify-otp', async (req, res) => {
  const { phone, otp, security_access_key } = req.body;
  if (!phone || !otp || !security_access_key) {
    return res.status(400).json({ error: 'phone, otp, and security_access_key required' });
  }

  const official = db.prepare(`SELECT * FROM officials WHERE phone = ? AND is_active = 1`).get(phone);
  if (!official) return res.status(404).json({ error: 'No active official account' });

  const otpResult = await otpService.verifyOtp(phone, otp, 'official_login');
  if (!otpResult.valid) return res.status(400).json({ error: `OTP invalid: ${otpResult.reason}` });

  const keyOk = await bcrypt.compare(security_access_key, official.security_access_key_hash);
  if (!keyOk) return res.status(401).json({ error: 'Invalid security access key' });

  db.prepare(`UPDATE officials SET is_phone_verified = 1 WHERE id = ?`).run(official.id);

  const token = sign({
    id: official.id,
    phone: official.phone,
    regionId: official.region_id,
    role: official.role,
    type: 'official',
  });

  res.json({
    token,
    official: { id: official.id, name: official.name, region_id: official.region_id, role: official.role },
  });
});

module.exports = router;
