const Redis = require('ioredis');
require('dotenv').config();

// Works with Upstash Redis (use the rediss:// TLS URL they give you)
const redis = new Redis(process.env.REDIS_URL, {
  maxRetriesPerRequest: 3,
  tls: process.env.REDIS_URL && process.env.REDIS_URL.startsWith('rediss://') ? {} : undefined,
});

redis.on('error', (err) => console.error('[redis] error:', err.message));
redis.on('connect', () => console.log('[redis] connected'));

module.exports = redis;
