// scripts/migrate-002.js
require('dotenv').config();
const db = require('../src/db/init');

const stmts = [
  `ALTER TABLE routes ADD COLUMN polyline TEXT`,
  `ALTER TABLE routes ADD COLUMN polyline_length_m REAL`,
  `ALTER TABLE bookings ADD COLUMN boarding_lat REAL`,
  `ALTER TABLE bookings ADD COLUMN boarding_lng REAL`,
  `ALTER TABLE bookings ADD COLUMN dropping_lat REAL`,
  `ALTER TABLE bookings ADD COLUMN dropping_lng REAL`,
  `ALTER TABLE bookings ADD COLUMN boarding_name TEXT`,
  `ALTER TABLE bookings ADD COLUMN dropping_name TEXT`,
  `CREATE TABLE IF NOT EXISTS picked_points (
     id TEXT PRIMARY KEY, name TEXT, lat REAL NOT NULL, lng REAL NOT NULL,
     formatted_address TEXT, created_at TEXT DEFAULT (datetime('now')))`,
];

for (const sql of stmts) {
  try { db.exec(sql); console.log('OK   ', sql.slice(0, 60)); }
  catch (e) { console.log('SKIP ', e.message); }
}
console.log('Migration done.');
process.exit(0);