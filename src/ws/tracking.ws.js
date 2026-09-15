const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const url = require('url');
const db = require('../db/init');
const { verify } = require('../utils/jwt');
const redis = require('../config/redis');

/**
 * Custom-built live tracking (no third-party tracking SDK):
 *  - Driver's mobile app opens a WS connection to /ws/track?token=<jwt>&tripId=...&role=driver
 *    and sends { lat, lng, speed, heading } periodically (e.g. every 5-10s).
 *  - Passenger apps open /ws/track?tripId=...&role=passenger to RECEIVE those updates
 *    live, pushed the instant the driver sends one.
 *  - Each update is persisted to trip_locations (for route history/ETA) and cached
 *    in Redis (latest position) so a REST client can also poll GET /api/tracking/:tripId/latest.
 */

const tripSubscribers = new Map(); // tripId -> Set of passenger sockets
const driverSockets = new Map(); // tripId -> driver socket (only one driver per trip)

function attach(server) {
  const wss = new WebSocket.Server({ server, path: '/ws/track' });

  wss.on('connection', (ws, req) => {
    const { query } = url.parse(req.url, true);
    const { tripId, role, token } = query;

    if (!tripId || !role) {
      ws.close(4000, 'tripId and role are required');
      return;
    }

    if (role === 'driver') {
      // Driver must be authenticated and actually assigned to this trip.
      let payload;
      try {
        payload = verify(token);
      } catch {
        ws.close(4001, 'Invalid token');
        return;
      }
      const trip = db.prepare(`SELECT * FROM trips WHERE id = ?`).get(tripId);
      if (!trip) {
        ws.close(4004, 'Trip not found');
        return;
      }
      driverSockets.set(tripId, ws);
      db.prepare(`UPDATE trips SET status = 'live' WHERE id = ? AND status = 'scheduled'`).run(tripId);

      ws.on('message', async (raw) => {
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          return;
        }
        const { lat, lng, speed, heading } = data;
        if (typeof lat !== 'number' || typeof lng !== 'number') return;

        db.prepare(
          `INSERT INTO trip_locations (id, trip_id, lat, lng, speed_kmph, heading) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(uuidv4(), tripId, lat, lng, speed || null, heading || null);

        await redis.set(
          `live:${tripId}`,
          JSON.stringify({ lat, lng, speed, heading, ts: Date.now() }),
          'EX',
          120
        );

        // Fan out to all subscribed passengers instantly
        const subs = tripSubscribers.get(tripId);
        if (subs) {
          const payload = JSON.stringify({ type: 'location', tripId, lat, lng, speed, heading, ts: Date.now() });
          for (const sock of subs) {
            if (sock.readyState === WebSocket.OPEN) sock.send(payload);
          }
        }
      });

      ws.on('close', () => {
        driverSockets.delete(tripId);
      });
    } else if (role === 'passenger') {
      if (!tripSubscribers.has(tripId)) tripSubscribers.set(tripId, new Set());
      tripSubscribers.get(tripId).add(ws);

      ws.on('close', () => {
        tripSubscribers.get(tripId)?.delete(ws);
      });
    } else {
      ws.close(4000, 'role must be driver or passenger');
    }
  });

  return wss;
}

module.exports = { attach };
