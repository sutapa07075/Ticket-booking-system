const bcrypt = require('bcryptjs');
const db = require('../db/init');
const redis = require('../config/redis');
const { v4: uuidv4 } = require('uuid');

/**
 * Authenticates external companies calling our public booking API.
 * Requires headers: x-api-key, x-api-secret
 * Only partners with status = 'approved' (verified company docs, GSTIN/CIN
 * checked by an official) may call booking endpoints.
 */
async function requirePartnerAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const apiSecret = req.headers['x-api-secret'];

  if (!apiKey || !apiSecret) {
    return res.status(401).json({ error: 'x-api-key and x-api-secret headers required' });
  }

  // api_key itself is looked up in plaintext-ish indexable form; here we scan
  // (fine for a student project scale — swap for an indexed key lookup table
  // if you expect many partners).
  const partners = db.prepare(`SELECT * FROM api_partners WHERE status = 'approved'`).all();

  let matched = null;
  for (const p of partners) {
    const keyOk = await bcrypt.compare(apiKey, p.api_key_hash);
    if (keyOk) {
      const secretOk = await bcrypt.compare(apiSecret, p.api_secret_hash);
      if (secretOk) {
        matched = p;
        break;
      }
    }
  }

  if (!matched) {
    return res.status(401).json({ error: 'Invalid API credentials or partner not approved' });
  }

  // Per-partner rate limiting via Redis sliding window (simple fixed-window here)
  const windowKey = `ratelimit:${matched.id}:${Math.floor(Date.now() / 60000)}`;
  const count = await redis.incr(windowKey);
  if (count === 1) await redis.expire(windowKey, 60);
  if (count > (matched.rate_limit_per_min || 60)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  db.prepare(
    `INSERT INTO api_request_log (id, partner_id, endpoint, status_code) VALUES (?, ?, ?, 200)`
  ).run(uuidv4(), matched.id, req.originalUrl);

  req.partner = matched;
  next();
}

module.exports = { requirePartnerAuth };
