const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/init');

const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ATTEMPTS = 5;

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6-digit
}

async function sendOtp(phone, purpose = 'login') {
  const otp = generateOtp();
  const hash = await bcrypt.hash(otp, 10);
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();

  db.prepare(
    `INSERT INTO otps (id, phone, otp_hash, purpose, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(uuidv4(), phone, hash, purpose, expiresAt);

  if (process.env.OTP_DEMO_MODE === 'true' || !process.env.SMS_API_KEY) {
    // Demo mode: log to console instead of sending real SMS.
    console.log(`\n📱 [DEMO OTP] Phone: ${phone} | Purpose: ${purpose} | OTP: ${otp}\n`);
  } else {
    // TODO: integrate real SMS gateway (MSG91 / Twilio) here using SMS_API_KEY
    // await axios.post('https://sms-gateway.example.com/send', {...})
  }

  return { sent: true, expiresAt };
}

async function verifyOtp(phone, otp, purpose = 'login') {
  const row = db
    .prepare(
      `SELECT * FROM otps WHERE phone = ? AND purpose = ? AND consumed = 0
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(phone, purpose);

  if (!row) return { valid: false, reason: 'no_otp_found' };
  if (new Date(row.expires_at) < new Date()) return { valid: false, reason: 'expired' };
  if (row.attempts >= MAX_ATTEMPTS) return { valid: false, reason: 'too_many_attempts' };

  const match = await bcrypt.compare(otp, row.otp_hash);

  if (!match) {
    db.prepare(`UPDATE otps SET attempts = attempts + 1 WHERE id = ?`).run(row.id);
    return { valid: false, reason: 'incorrect' };
  }

  db.prepare(`UPDATE otps SET consumed = 1 WHERE id = ?`).run(row.id);
  return { valid: true };
}

module.exports = { sendOtp, verifyOtp };
