# BusGo — Bus Ticket Booking Platform (Student Project)

Node.js + Express + SQLite backend implementing OTP auth, route search with
autocomplete, live GPS tracking via WebSockets, dynamic pricing, Razorpay
payments, official/region-based bus & KYC management, and a multi-partner
booking API with double-booking prevention.

## 1. Setup

```bash
cd bus-booking
npm install
cp .env.example .env      # fill in real keys (see below)
npm run initdb             # creates SQLite file + tables
npm run dev                 # nodemon, or `npm start`
```

Server runs at `http://localhost:4000`. The pages are now a connected app,
not standalone demos — start at `/index.html`:

1. `index.html` — log in with phone + OTP → redirects to `search.html`
2. `search.html` — autocomplete origin/destination, see the route drawn on
   the map, pick a trip → goes to `booking.html?tripId=...`
3. `booking.html` — seat map, Razorpay checkout → on success goes to `bookings.html`
4. `bookings.html` — your bookings, cancel (75% refund), or jump to `track.html`
5. `track.html?tripId=...` — live bus position over WebSocket
6. `driver.html` — simulates the driver's phone sending GPS (feeds `track.html`)
7. `official.html` — separate login (phone+OTP+security key), region dashboard:
   register driver (KYC), register bus, create route, schedule trip, cancel route

Page-by-page summary:
- `public/index.html` — OTP login
- `public/search.html` — search with Google Places autocomplete, draws the
  real road route on Google Maps, lists direct + connecting trips
- `public/track.html?tripId=...` — live bus position on Google Maps, updated
  in real time over WebSocket, with the travelled breadcrumb trail drawn in
- `public/driver.html` — simulates the driver's phone: reads your device GPS
  and streams it over WebSocket (open this on a phone or another tab to feed
  `track.html` live data)

**Before the map pages will render anything**, edit ONE file:
`public/js/config.js`, and set `GOOGLE_MAPS_BROWSER_KEY` to a real key.

### Using Google's free "Maps Demo Key" (no billing account)
This project now calls only APIs that Google's no-cost Maps Demo Key
supports: **Places API (New)** for autocomplete/place details, and the
**Routes API "Compute Routes"** for drawing the road route — not the legacy
Places Autocomplete, Place Details, or Directions APIs, which the demo key
does not include. Get a demo key at
https://developers.google.com/maps/get-started#demo-key and use the same
key for both `.env` (`GOOGLE_MAPS_API_KEY`) and `public/js/config.js`
(`GOOGLE_MAPS_BROWSER_KEY`) — no billing account needed for local testing.
If you later attach billing to a real key, this same code keeps working —
these are Google's current recommended APIs either way.

Anywhere Places/Routes genuinely isn't available (quota, network, a typo in
the key), the app degrades instead of breaking: autocomplete inputs
automatically offer a "type it manually" fallback (via a new
`/api/places/manual` endpoint that makes no Google call at all), and the map
panel shows a message instead of a blank/broken box.

### Which URL to put in the Google Cloud Console restriction
This confused things before — here's the exact answer. In Google Cloud
Console → Credentials → your browser key → **Application restrictions** →
choose **"HTTP referrers (web sites)"** and add these two entries:
```
http://localhost:4000/*
http://127.0.0.1:4000/*
```
Then under **API restrictions**, enable: **Maps JavaScript API**, **Places
API**, **Directions API**. When you deploy for real, add your actual domain
(e.g. `https://yourapp.com/*`) as a third referrer entry.

This browser key must be **different** from `GOOGLE_MAPS_API_KEY` in your
server `.env` (used for server-side Places Autocomplete/Details + Distance
Matrix calls) — restrict that one by **IP address** instead, and never put
it in any HTML/JS file, since anything in `public/` is visible to everyone.

### Getting a Razorpay test key working end-to-end
`booking.html` calls `GET /api/config` to fetch your publishable
`RAZORPAY_KEY_ID` at runtime — just fill in `RAZORPAY_KEY_ID` and
`RAZORPAY_KEY_SECRET` in `.env` from your Razorpay **Test Mode** dashboard
and checkout will open automatically. No frontend file needs editing for this.

### First-time official setup
Go to `official.html` → open "First time setup" → use the
`SUPER_ADMIN_SETUP_KEY` from your `.env` to create your first region and
super-admin account, then log in normally with phone + OTP + the access key
you just chose.

### Keys you need to get (all have free/sandbox tiers)
| Service | Used for | Get it from |
|---|---|---|
| Google Maps API | place autocomplete, geocoding, distance | Google Cloud Console — enable Places API + Distance Matrix API |
| Razorpay | payments + refunds | dashboard.razorpay.com (Test Mode keys) |
| Upstash Redis | seat locking, rate limiting, live-location cache | upstash.com free tier |
| Backblaze B2 | storing PAN/Aadhaar/selfie KYC images | backblaze.com, create a **private** bucket |
| API Setu sandbox | PAN/Aadhaar verification (demo) | apisetu.gov.in — register for sandbox access |

In demo mode (`OTP_DEMO_MODE=true`, default), OTPs are printed to the server
console instead of sent via SMS — no SMS gateway needed to test.

## 2. Architecture at a glance

```
src/
  db/schema.sql        <- full relational schema (users, officials, regions,
                           buses, drivers, routes, trips, bookings, partners...)
  services/
    otp.service.js       OTP generation/hashing/verification
    googleMaps.service.js  place autocomplete + distance
    routeSearch.service.js graph search: direct + 1-transfer connecting routes
    pricing.service.js   multi-factor dynamic price engine (cron every 30 min)
    seatLock.service.js  Redis-based per-seat lock -> prevents double booking
    booking.service.js   shared booking logic (used by BOTH web + partner API)
    razorpay.service.js  order creation, signature check, 75% refund
    apiSetu.service.js   PAN/Aadhaar verification (sandbox)
    storage.service.js   Backblaze B2 upload/download for KYC docs
  routes/               Express routers (thin, call into services)
  middleware/
    auth.js               JWT auth for users & officials
    apiPartnerAuth.js      API-key/secret auth + per-partner rate limit for resellers
  ws/tracking.ws.js     WebSocket hub: driver pushes GPS, passengers get pushed updates
```

## 3. How the tricky parts work

### Double-booking prevention (single site AND multi-partner)
Two layers, both required:
1. **Redis lock** (`seatLock.service.js`) — the instant a user selects seats,
   we try to `SET seat:trip:seatId NX PX 5min`. If any seat is already locked,
   the whole request fails immediately with which seats conflicted.
2. **DB UNIQUE constraint** (`booking_seats(trip_id, seat_id)`) — the final,
   unbypassable guarantee when payment is confirmed. Even if two requests
   somehow both got a Redis lock (clock skew, bug, etc.), only one INSERT
   succeeds; the other is caught and refunded.

Partner-company bookings call the **exact same** `booking.service.js`
functions as the website — there's no separate, weaker code path for them.

### Partner (reseller) verification
A company calls `POST /api/partner/apply` with company name, GSTIN/CIN, and
a proof-of-business document. They get an API key/secret immediately but
status = `pending_review` — every partner-auth-protected endpoint checks
`status = 'approved'`, so they **cannot book anything** until a super-admin
official reviews and approves them via `POST /api/partner/:id/review`.
Per-partner rate limiting is enforced with a Redis counter.

### Region-scoped officials
Each `region` has a `region_code`. Officials belong to exactly one region
(`officials.region_id`). Every write to `buses`, `routes`, or trip
cancellation checks `req.official.regionId === resource.region_id` — an
official literally cannot modify another region's data, enforced at the
route-handler level.

### Live tracking (custom-built, not a 3rd-party SDK)
Driver's phone opens `ws://.../ws/track?tripId=X&role=driver&token=JWT` and
sends `{lat, lng, speed, heading}` every few seconds. The server persists
each ping to `trip_locations`, caches the latest in Redis, and immediately
fans it out to every passenger socket subscribed to that trip
(`?tripId=X&role=passenger`). REST fallback: `GET /api/tracking/:tripId/latest`.

### Dynamic pricing
`pricing.service.js` combines: occupancy/demand, weekend/vacation calendar,
weather (stubbed — wire up a weather API with the route's lat/lng), fuel
index (stubbed), and a last-minute discount window (< 3h to departure with
empty seats → price drops to fill the bus). Combined multiplier is clamped
to **0.7x–1.6x** of base price so swings stay fair. A cron job
(`node-cron`, every 30 min) recalculates every upcoming trip and logs a full
`trip_price_history` audit row each time.

### Route search + "change bus here" suggestions
`routeSearch.service.js` does a simple graph search over `routes` +
`route_stops`: first looks for a **direct** route covering origin→destination
(as two points in one route's ordered stop list); if none exists, it looks
for a **1-transfer connection** — route A reaches some intermediate stop,
route B continues from that same stop to the destination — and returns it
labeled with `changeAtLocationId` so the UI can say "board Bus A, alight at
X, change to Bus B."

### KYC (driver) verification
On `POST /api/official/drivers` (multipart: pan_image, aadhaar_image,
selfie_image), documents go to Backblaze B2 (private bucket), then PAN +
Aadhaar are checked against **API Setu sandbox** (demo-grade, not real
UIDAI verification — fine for a student project). Face-match between PAN
photo and Aadhaar/selfie is a stub (`apiSetu.service.js: faceMatch`) — swap
in a real face-match provider (AWS Rekognition, Azure Face) for production.

## 4. Key API endpoints

```
POST /api/auth/user/request-otp        { phone }
POST /api/auth/user/verify-otp         { phone, otp, name? } -> JWT
POST /api/auth/official/request-otp    { phone }
POST /api/auth/official/verify-otp     { phone, otp, security_access_key } -> JWT

GET  /api/places/autocomplete?input=&session=
POST /api/places/resolve               { place_id }

GET  /api/journey/search?origin=&destination=&date=

GET  /api/bookings/trip/:tripId/seats
POST /api/bookings/initiate            { tripId, seatIds[], boardingStopId, droppingStopId }  [auth]
POST /api/bookings/confirm             { bookingId, holderId, seatIds[], razorpay_* }          [auth]
POST /api/bookings/:id/cancel                                                                    [auth] -> 75% refund

GET  /api/tracking/:tripId/latest
GET  /api/tracking/:tripId/history
WS   /ws/track?tripId=&role=driver&token=JWT      (driver sends {lat,lng,speed,heading})
WS   /ws/track?tripId=&role=passenger             (receives live pushes)

POST /api/official/bootstrap           { setup_key, region_code, region_name, admin_name, admin_phone, admin_access_key }
POST /api/official/regions                                                                       [super admin]
POST /api/official/officials                                                                      [super admin]
POST /api/official/drivers             multipart: pan_image, aadhaar_image, selfie_image          [official]
POST /api/official/buses                                                                          [official, region-scoped]
POST /api/official/routes                                                                         [official, region-scoped]
POST /api/official/routes/:id/cancel                                                              [official, region-scoped]
POST /api/official/trips                                                                          [official, region-scoped]

POST /api/partner/apply                { company_name, contact_email, gstin, cin, business_doc_key }
POST /api/partner/:id/review           { decision: 'approved'|'rejected' }                        [super admin]
GET  /api/partner/trip/:tripId/seats                                              [x-api-key/secret]
POST /api/partner/booking/initiate     { userPhone, tripId, seatIds[] }           [x-api-key/secret]
POST /api/partner/booking/confirm      { ... razorpay fields }                    [x-api-key/secret]
```

## 5. Honest scope notes (for a student project, be upfront about these)

- **Weather & fuel-price factors** in pricing are stubbed at neutral (1.0) —
  wire up a real weather API (OpenWeather etc.) and a fuel-price feed to
  make them live.
- **Face-match** for KYC is a stub returning "manual review required" — real
  biometric face-match needs a licensed provider.
- **API Setu sandbox** returns test/mock data, not real government
  verification — correct for a demo, not for production KYC.
- The partner-auth lookup scans approved partners and bcrypt-compares each
  (fine at small scale for a student project); at real scale, look up by a
  non-hashed key prefix first.
- SQLite (via `better-sqlite3`) is used per your request; for real concurrent
  production traffic you'd typically move to Postgres (e.g. Neon, which you
  mentioned) — the schema is plain SQL and would port over with minor tweaks
  (e.g. `TEXT` timestamps → `TIMESTAMPTZ`, `datetime('now')` → `now()`).
