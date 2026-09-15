const { verify } = require('../utils/jwt');

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const payload = verify(header.split(' ')[1]);
    req.user = payload; // { id, phone, type: 'user' }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireOfficial(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing token' });
  }
  try {
    const payload = verify(header.split(' ')[1]);
    if (payload.type !== 'official') {
      return res.status(403).json({ error: 'Official access only' });
    }
    req.official = payload; // { id, phone, regionId, role, type: 'official' }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireSuperAdmin(req, res, next) {
  requireOfficial(req, res, () => {
    if (req.official.role !== 'super_admin') {
      return res.status(403).json({ error: 'Super admin only' });
    }
    next();
  });
}

module.exports = { requireAuth, requireOfficial, requireSuperAdmin };
