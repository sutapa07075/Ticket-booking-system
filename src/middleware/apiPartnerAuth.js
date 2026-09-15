const bcrypt = require('bcryptjs');
const db = require('../db/init');

/**
 * Partner auth via x-api-key / x-api-secret headers. Only 'approved'
 * partners can use booking endpoints (see partner.routes.js comments).
 * Bcrypt-compares against every approved partner's hash — fine at small
 * scale for a student project (see README known-simplifications).
 */
async function requirePartnerAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const apiSecret = req.headers['x-api-secret'];
  if (!apiKey || !apiSecret) {
    return res.status(401).json({ error: 'x-api-key and x-api-secret headers required' });
  }

  const partners = db.prepare(`SELECT * FROM api_partners WHERE status = 'approved'`).all();
  for (const p of partners) {
    const keyOk = await bcrypt.compare(apiKey, p.api_key_hash);
    if (!keyOk) continue;
    const secretOk = await bcrypt.compare(apiSecret, p.api_secret_hash);
    if (!secretOk) break;
    req.partner = { id: p.id, company_name: p.company_name };
    return next();
  }

  res.status(401).json({ error: 'Invalid API credentials, or your application is not yet approved' });
}

module.exports = { requirePartnerAuth };
