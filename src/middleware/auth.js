const { verify } = require('../utils/jwt');
const db = require('../db/init');

function getToken(req) {
  const h = req.headers.authorization || '';
  const [type, token] = h.split(' ');
  return type === 'Bearer' ? token : null;
}

function requireAuth(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Authorization token required' });
  try {
    const payload = verify(token);
    if (payload.type !== 'user') return res.status(403).json({ error: 'User token required' });
    req.user = payload;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireOfficial(req, res, next) {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: 'Authorization token required' });
  try {
    const payload = verify(token);
    if (payload.type !== 'official') return res.status(403).json({ error: 'Official token required' });
    const official = db.prepare(`SELECT * FROM officials WHERE id = ? AND is_active = 1`).get(payload.id);
    if (!official) return res.status(403).json({ error: 'Official account not found or inactive' });
    req.official = { id: official.id, regionId: official.region_id, role: official.role, name: official.name };
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireSuperAdmin(req, res, next) {
  requireOfficial(req, res, () => {
    if (req.official.role !== 'super_admin') {
      return res.status(403).json({ error: 'Super admin access required' });
    }
    next();
  });
}

module.exports = { requireAuth, requireOfficial, requireSuperAdmin };
