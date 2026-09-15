require('dotenv').config();
const express = require('express');
const http = require('http');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const path = require('path');

require('./db/init'); // ensures schema is applied on boot

const authRoutes = require('./routes/auth.routes');
const placesRoutes = require('./routes/places.routes');
const journeyRoutes = require('./routes/journey.routes');
const bookingRoutes = require('./routes/booking.routes');
const trackingRoutes = require('./routes/tracking.routes');
const officialRoutes = require('./routes/official.routes');
const partnerRoutes = require('./routes/partner.routes');

const trackingWs = require('./ws/tracking.ws');
const { recalculateAllUpcomingTrips } = require('./services/pricing.service');

const app = express();
// Helmet's default CSP blocks inline <script> tags and onclick="" handlers,
// which this frontend uses throughout. Disabling CSP here (fine for a student
// project served same-origin); if you productionize this, either move all
// JS to external files with a nonce-based CSP, or configure directives
// explicitly instead of disabling wholesale.
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// General API rate limit (partner-specific limits are handled separately)
app.use('/api/', rateLimit({ windowMs: 60 * 1000, max: 120 }));

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Public, non-secret config the frontend needs at runtime (safe to expose: this is
// Razorpay's publishable key id, not the secret).
app.get('/api/config', (req, res) => {
  res.json({ razorpayKeyId: process.env.RAZORPAY_KEY_ID || null });
});

app.use('/api/auth', authRoutes);
app.use('/api/places', placesRoutes);
app.use('/api/journey', journeyRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/tracking', trackingRoutes);
app.use('/api/official', officialRoutes);
app.use('/api/partner', partnerRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = http.createServer(app);
trackingWs.attach(server);

// Safety net: log unexpected errors instead of letting them crash the whole
// server (which is what was happening before every route had its own
// try/catch). Ideally every route wraps its own errors properly — this is
// just a last-resort backstop so one bad request never takes down everyone
// else's active session.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// Recalculate every trip's dynamic price every 30 minutes
cron.schedule('*/30 * * * *', async () => {
  const n = await recalculateAllUpcomingTrips();
  console.log(`[pricing-cron] recalculated ${n} trips`);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚌 Bus booking server running on http://localhost:${PORT}`);
  console.log(`   WebSocket tracking on ws://localhost:${PORT}/ws/track`);
});
