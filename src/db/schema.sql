-- ==========================================================
-- BUS TICKET BOOKING SYSTEM - SQLite SCHEMA
-- ==========================================================

PRAGMA foreign_keys = ON;

-- ---------- USERS (passengers) ----------
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,              -- uuid
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  email TEXT,
  is_phone_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ---------- OTP store ----------
CREATE TABLE IF NOT EXISTS otps (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  otp_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'login', -- login | official_login
  expires_at TEXT NOT NULL,
  attempts INTEGER DEFAULT 0,
  consumed INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_otps_phone ON otps(phone);

-- ---------- REGIONS ----------
-- Each region has one special "region code" and one or more officials
CREATE TABLE IF NOT EXISTS regions (
  id TEXT PRIMARY KEY,
  region_code TEXT UNIQUE NOT NULL,   -- e.g. "WB-01"
  name TEXT NOT NULL,                 -- e.g. "West Bengal - Burdwan Division"
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---------- OFFICIALS (govt/regional authority accounts) ----------
CREATE TABLE IF NOT EXISTS officials (
  id TEXT PRIMARY KEY,
  phone TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  security_access_key_hash TEXT NOT NULL,  -- hashed access key
  region_id TEXT NOT NULL REFERENCES regions(id),
  role TEXT DEFAULT 'regional_officer',     -- regional_officer | super_admin
  is_active INTEGER DEFAULT 1,
  is_phone_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---------- LOCATIONS (for autocomplete / route graph) ----------
-- Cached place data (from Google Places) so we don't hit the API every keystroke
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  place_id TEXT UNIQUE,          -- Google place_id
  name TEXT NOT NULL,
  formatted_address TEXT,
  lat REAL,
  lng REAL,
  city TEXT,
  state TEXT,
  is_bus_stop INTEGER DEFAULT 0, -- 1 if this is a recognized bus stand/stop
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_locations_name ON locations(name);

-- ---------- DRIVERS ----------
CREATE TABLE IF NOT EXISTS drivers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  is_phone_verified INTEGER DEFAULT 0,
  pan_number TEXT,
  aadhaar_number TEXT,
  pan_image_key TEXT,        -- storage key (Backblaze B2)
  aadhaar_image_key TEXT,
  selfie_image_key TEXT,     -- live selfie used for face-match
  kyc_status TEXT DEFAULT 'pending', -- pending | verified | rejected
  kyc_verified_at TEXT,
  registered_by_official_id TEXT REFERENCES officials(id),
  region_id TEXT REFERENCES regions(id),
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---------- BUSES ----------
CREATE TABLE IF NOT EXISTS buses (
  id TEXT PRIMARY KEY,
  registration_number TEXT UNIQUE NOT NULL,
  operator_name TEXT,
  bus_type TEXT DEFAULT 'seater', -- seater | sleeper | ac | non_ac
  total_seats INTEGER NOT NULL,
  amenities TEXT,                 -- json array
  region_id TEXT NOT NULL REFERENCES regions(id),
  registered_by_official_id TEXT REFERENCES officials(id),
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bus_drivers (
  id TEXT PRIMARY KEY,
  bus_id TEXT NOT NULL REFERENCES buses(id),
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  assigned_at TEXT DEFAULT (datetime('now')),
  UNIQUE(bus_id, driver_id)
);

-- ---------- SEATS (seat map per bus, static layout) ----------
CREATE TABLE IF NOT EXISTS bus_seats (
  id TEXT PRIMARY KEY,
  bus_id TEXT NOT NULL REFERENCES buses(id),
  seat_number TEXT NOT NULL,   -- e.g. "A1"
  seat_type TEXT DEFAULT 'seater', -- seater | sleeper | ladies | premium
  deck TEXT DEFAULT 'lower',
  UNIQUE(bus_id, seat_number)
);

-- ---------- ROUTES ----------
-- A route is defined by an official: origin -> destination with intermediate stops
CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  route_code TEXT UNIQUE,
  origin_location_id TEXT NOT NULL REFERENCES locations(id),
  destination_location_id TEXT NOT NULL REFERENCES locations(id),
  distance_km REAL,
  base_duration_min INTEGER,
  region_id TEXT NOT NULL REFERENCES regions(id),
  created_by_official_id TEXT REFERENCES officials(id),
  is_cancelled INTEGER DEFAULT 0,
  cancelled_by_official_id TEXT REFERENCES officials(id),
  cancelled_reason TEXT,
  default_bus_id TEXT REFERENCES buses(id),
  default_price REAL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Ordered intermediate stops for a route (used for connecting/transfer suggestions)
CREATE TABLE IF NOT EXISTS route_stops (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  location_id TEXT NOT NULL REFERENCES locations(id),
  stop_order INTEGER NOT NULL,
  eta_offset_min INTEGER,  -- minutes from route start
  UNIQUE(route_id, stop_order)
);

-- Which days of week a route operates: comma list e.g. "MON,TUE,WED"
CREATE TABLE IF NOT EXISTS route_schedule (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  days_of_week TEXT NOT NULL,
  departure_time TEXT NOT NULL -- "HH:MM"
);

-- ---------- TRIPS (a specific bus running a specific route on a specific date) ----------
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  bus_id TEXT NOT NULL REFERENCES buses(id),
  driver_id TEXT REFERENCES drivers(id),
  travel_date TEXT NOT NULL,      -- "YYYY-MM-DD"
  departure_time TEXT NOT NULL,
  status TEXT DEFAULT 'scheduled', -- scheduled | live | completed | cancelled
  base_price REAL NOT NULL,
  current_price REAL NOT NULL,    -- dynamically updated
  last_price_update TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_trips_date ON trips(travel_date);

-- Price history so we can audit surge/discount changes
CREATE TABLE IF NOT EXISTS trip_price_history (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  price REAL NOT NULL,
  factors_json TEXT, -- snapshot of factors used (weather, demand, fuel, seats_left...)
  created_at TEXT DEFAULT (datetime('now'))
);

-- Live GPS pings from driver app
CREATE TABLE IF NOT EXISTS trip_locations (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  speed_kmph REAL,
  heading REAL,
  recorded_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_triploc_trip ON trip_locations(trip_id, recorded_at);

-- ---------- BOOKINGS ----------
CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  boarding_stop_id TEXT REFERENCES locations(id),
  dropping_stop_id TEXT REFERENCES locations(id),
  status TEXT DEFAULT 'pending_payment', -- pending_payment | confirmed | cancelled | completed
  total_amount REAL NOT NULL,
  refund_amount REAL,
  source TEXT DEFAULT 'web',   -- web | partner:<partner_id>
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS booking_seats (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  seat_id TEXT NOT NULL REFERENCES bus_seats(id),
  price REAL NOT NULL,
  UNIQUE(trip_id, seat_id) -- DB-level guard: a seat can only be booked once per trip
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  razorpay_order_id TEXT,
  razorpay_payment_id TEXT,
  razorpay_signature TEXT,
  amount REAL NOT NULL,
  status TEXT DEFAULT 'created', -- created | paid | failed | refunded | partially_refunded
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---------- PARTNER API CLIENTS (other companies reselling via API) ----------
CREATE TABLE IF NOT EXISTS api_partners (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_email TEXT NOT NULL,
  contact_phone TEXT,
  gstin TEXT,
  cin TEXT,                        -- company incorporation number
  business_doc_key TEXT,           -- proof-of-business document (B2 storage key)
  api_key_hash TEXT NOT NULL,
  api_secret_hash TEXT NOT NULL,
  status TEXT DEFAULT 'pending_review', -- pending_review | approved | rejected | suspended
  approved_by_official_id TEXT REFERENCES officials(id),
  rate_limit_per_min INTEGER DEFAULT 60,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_request_log (
  id TEXT PRIMARY KEY,
  partner_id TEXT REFERENCES api_partners(id),
  endpoint TEXT,
  status_code INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Diesel/fuel price index used by the pricing engine's fuel factor.
-- Updated either by a super admin manually, or automatically by a cron job
-- if FUEL_PRICE_API_URL is configured (see pricing.service.js). Keeping a
-- history (not just one row) lets you audit how the index has moved.
CREATE TABLE IF NOT EXISTS fuel_price_index (
  id TEXT PRIMARY KEY,
  price_per_liter REAL NOT NULL,
  source TEXT DEFAULT 'manual',
  updated_by_official_id TEXT REFERENCES officials(id),
  created_at TEXT DEFAULT (datetime('now'))
);
-- ==========================================================
-- ON-ROUTE SEARCH SUPPORT 
-- ==========================================================

CREATE TABLE IF NOT EXISTS picked_points (
  id                TEXT PRIMARY KEY,
  name              TEXT,
  lat               REAL NOT NULL,
  lng               REAL NOT NULL,
  formatted_address TEXT,
  created_at        TEXT DEFAULT (datetime('now'))
);

