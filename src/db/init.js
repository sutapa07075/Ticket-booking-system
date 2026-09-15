const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
require('dotenv').config();

const dbPath = process.env.SQLITE_PATH || './data/bus.db';
const dir = path.dirname(dbPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Lightweight migration for databases created before newer columns existed.
// Safe to run every boot — SQLite errors on duplicate column, which we ignore.
for (const stmt of [
  `ALTER TABLE routes ADD COLUMN default_bus_id TEXT REFERENCES buses(id)`,
  `ALTER TABLE routes ADD COLUMN default_price REAL`,
  `ALTER TABLE routes ADD COLUMN polyline TEXT`,
  `ALTER TABLE routes ADD COLUMN polyline_length_m REAL`,
  `ALTER TABLE bookings ADD COLUMN boarding_lat REAL`,
  `ALTER TABLE bookings ADD COLUMN boarding_lng REAL`,
  `ALTER TABLE bookings ADD COLUMN dropping_lat REAL`,
  `ALTER TABLE bookings ADD COLUMN dropping_lng REAL`,
  `ALTER TABLE bookings ADD COLUMN boarding_name TEXT`,
  `ALTER TABLE bookings ADD COLUMN dropping_name TEXT`,
]) {
  try { db.exec(stmt); } catch (e) { /* column already exists — fine */ }
}

if (require.main === module) {
  console.log(`SQLite initialized at ${dbPath}`);
}

module.exports = db;