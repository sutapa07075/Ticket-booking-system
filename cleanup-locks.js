// cleanup-locks.js
require('dotenv').config();
const redis = require('./src/config/redis');

(async () => {
  const keys = await redis.keys('seatlock:*');
  console.log('Found', keys.length, 'seat locks');
  if (keys.length) {
    const n = await redis.del(...keys);
    console.log('Deleted', n);
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });