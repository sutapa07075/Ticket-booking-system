// src/services/routeSearch.service.js
const db = require('../db/init');
const polylineSvc = require('./polyline.service');

// Direct match: endpoint must be an official stop OR within this distance of
// the polyline. Anything further out is not a real direct ride — you'd be
// dropped kilometres away from where you asked to go.
const DIRECT_SNAP_OFFSET_M = 500;

// Connecting match: an on-route pickup (map-picked point, unofficial stop)
// may be slightly off the road. This is the tolerance for treat-as-a-hub.
const CONNECTING_SNAP_OFFSET_M = 3000;

const MIN_TRANSFER_GAP_MIN = 20;
const MAX_TRANSFERS = 3;
const MAX_STATES = 5000;
const TRANSFER_HUB_TOLERANCE_M = 800;

function resolveEndpoint(input) {
  if (input.locationId) {
    const loc = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(input.locationId);
    if (!loc) throw new Error(`Location not found: ${input.locationId}`);
    return { lat: loc.lat, lng: loc.lng, locationId: loc.id, name: loc.name };
  }
  if (typeof input.lat === 'number' && typeof input.lng === 'number') {
    return { lat: input.lat, lng: input.lng, locationId: null, name: input.name || 'Picked point' };
  }
  throw new Error('Endpoint must have locationId or {lat,lng}');
}

function getRouteStopsInOrder(routeId) {
  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(routeId);
  const stops = db.prepare(`SELECT * FROM route_stops WHERE route_id = ? ORDER BY stop_order`).all(routeId);
  return [
    { location_id: route.origin_location_id, eta_offset_min: 0, kind: 'origin' },
    ...stops.map((s) => ({ ...s, kind: 'stop' })),
    { location_id: route.destination_location_id, eta_offset_min: route.base_duration_min, kind: 'destination' },
  ];
}

function activeRoutes() {
  return db.prepare(`SELECT * FROM routes WHERE is_cancelled = 0 AND polyline IS NOT NULL`).all();
}

/**
 * Locate an endpoint on a route, in two stages:
 *   1. If it's an official stop on this route, use its real coords.
 *   2. Otherwise snap to the polyline — but require a tight offset for
 *      "direct" use, and allow a looser offset for "connecting" use.
 *
 * Returns { fraction, snapped, etaOffsetMin, offsetM, isOfficialStop } or null.
 */
function locateOnRoute(route, endpoint, { maxOffsetM = DIRECT_SNAP_OFFSET_M } = {}) {
  if (!route.polyline) return null;
  const polyline = polylineSvc.decodePolyline(route.polyline);
  if (polyline.length < 2) return null;

  // Stage 1: match against official stops (if endpoint has a location_id)
  if (endpoint.locationId) {
    const stops = getRouteStopsInOrder(route.id);
    for (const s of stops) {
      if (s.location_id !== endpoint.locationId) continue;
      const loc = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(s.location_id);
      if (!loc || loc.lat == null || loc.lng == null) continue;
      const snap = polylineSvc.snapToPolyline(polyline, { lat: loc.lat, lng: loc.lng });
      const fraction = snap
        ? polylineSvc.fractionAlong(polyline, snap.alongM)
        : (s.eta_offset_min || 0) / (route.base_duration_min || 240);
      return {
        fraction,
        snapped: { lat: loc.lat, lng: loc.lng },
        etaOffsetMin: s.eta_offset_min != null
          ? s.eta_offset_min
          : Math.round((route.base_duration_min || 240) * fraction),
        offsetM: snap ? snap.offsetM : 0,
        isOfficialStop: true,
      };
    }
  }

  // Stage 2: geometric snap
  const snap = polylineSvc.snapToPolyline(polyline, { lat: endpoint.lat, lng: endpoint.lng });
  if (!snap || snap.offsetM > maxOffsetM) return null;
  const fraction = polylineSvc.fractionAlong(polyline, snap.alongM);
  return {
    fraction,
    snapped: snap.snapped,
    etaOffsetMin: Math.round((route.base_duration_min || 240) * fraction),
    offsetM: snap.offsetM,
    isOfficialStop: false,
  };
}

/**
 * Return every hub on a route (its stops + origin + destination), each with
 * a fraction [0..1] along the polyline.
 */
function hubsOnRoute(route) {
  const stops = getRouteStopsInOrder(route.id);
  const polyline = polylineSvc.decodePolyline(route.polyline || '');
  return stops.map((s) => {
    const loc = db.prepare(`SELECT * FROM locations WHERE id = ?`).get(s.location_id);
    if (!loc) return null;
    const snap = polyline.length >= 2
      ? polylineSvc.snapToPolyline(polyline, { lat: loc.lat, lng: loc.lng })
      : null;
    return {
      location_id: s.location_id,
      name: loc.name,
      lat: loc.lat,
      lng: loc.lng,
      fraction: snap ? polylineSvc.fractionAlong(polyline, snap.alongM) : 0,
      etaOffsetMin: s.eta_offset_min || 0,
    };
  }).filter(Boolean).sort((a, b) => a.fraction - b.fraction);
}

function routeNames(route) {
  const o = db.prepare(`SELECT name FROM locations WHERE id = ?`).get(route.origin_location_id);
  const d = db.prepare(`SELECT name FROM locations WHERE id = ?`).get(route.destination_location_id);
  return { origin_name: o ? o.name : null, destination_name: d ? d.name : null };
}

function search(originInput, destInput) {
  const origin = resolveEndpoint(originInput);
  const dest = resolveEndpoint(destInput);

  const routes = activeRoutes();

  // ---------- DIRECT ----------
  // Only routes where BOTH endpoints are within the tight direct tolerance
  // (or are official stops). This is what stops "Sealdah is 3km from the
  // Durgapur→Kolkata polyline" from being shown as a direct ride.
  const directMatches = [];
  for (const route of routes) {
    const o = locateOnRoute(route, origin, { maxOffsetM: DIRECT_SNAP_OFFSET_M });
    const d = locateOnRoute(route, dest, { maxOffsetM: DIRECT_SNAP_OFFSET_M });
    if (!o || !d) continue;
    if (o.fraction >= d.fraction) continue;
    directMatches.push({ route, o, d });
  }

  const direct = directMatches.map(({ route, o, d }) => {
    const names = routeNames(route);
    const isSubSegment = o.fraction > 0.05 || d.fraction < 0.95;
    return {
      type: 'direct',
      route: { ...route, ...names },
      isSubSegment,
      boardAt: {
        location_id: origin.locationId,
        lat: o.snapped.lat, lng: o.snapped.lng,
        fraction: o.fraction, eta_offset_min: o.etaOffsetMin,
        name: origin.name,
        isOfficialStop: o.isOfficialStop,
      },
      alightAt: {
        location_id: dest.locationId,
        lat: d.snapped.lat, lng: d.snapped.lng,
        fraction: d.fraction, eta_offset_min: d.etaOffsetMin,
        name: dest.name,
        isOfficialStop: d.isOfficialStop,
      },
    };
  });

  // ---------- CONNECTING ----------
  // Uses the looser tolerance so map-picked points a bit off-road still count.
  // Now collects all multi-leg paths and only returns those requiring >=1
  // transfer, so a "connecting" result always genuinely involves a change.
  const connecting = findConnecting({ origin, dest, routes });

  return { direct, connecting };
}

function findConnecting({ origin, dest, routes, maxResults = 5 }) {
  const routeData = routes.map((route) => {
    const hubs = hubsOnRoute(route);
    // For connecting, we want a looser snap tolerance
    const o = locateOnRoute(route, origin, { maxOffsetM: CONNECTING_SNAP_OFFSET_M });
    const d = locateOnRoute(route, dest,   { maxOffsetM: CONNECTING_SNAP_OFFSET_M });

    if (o && !hubs.some((h) => Math.abs(h.fraction - o.fraction) < 0.001)) {
      hubs.push({
        location_id: null, name: origin.name, lat: o.snapped.lat, lng: o.snapped.lng,
        fraction: o.fraction, etaOffsetMin: o.etaOffsetMin, synthetic: true,
      });
    }
    if (d && !hubs.some((h) => Math.abs(h.fraction - d.fraction) < 0.001)) {
      hubs.push({
        location_id: null, name: dest.name, lat: d.snapped.lat, lng: d.snapped.lng,
        fraction: d.fraction, etaOffsetMin: d.etaOffsetMin, synthetic: true,
      });
    }
    hubs.sort((a, b) => a.fraction - b.fraction);
    return { route, hubs, o, d };
  });

  function samePhysical(a, b) {
    if (a.location_id && b.location_id && a.location_id === b.location_id) return true;
    if (a.lat == null || a.lng == null || b.lat == null || b.lng == null) return false;
    const d = polylineSvc.haversineM({ lat: a.lat, lng: a.lng }, { lat: b.lat, lng: b.lng });
    return d < TRANSFER_HUB_TOLERANCE_M;
  }

  const seeds = [];
  for (const rd of routeData) {
    if (!rd.o) continue;
    const hub = rd.hubs.find((h) => Math.abs(h.fraction - rd.o.fraction) < 0.001);
    if (hub) seeds.push({ route: rd.route, hub, cost: 0, legs: [{ route: rd.route, boardAt: hub }] });
  }

  const visited = new Set();
  const queue = seeds.slice();
  const foundPaths = [];

  while (queue.length) {
    queue.sort((a, b) => a.cost - b.cost);
    const cur = queue.shift();
    const key = `${cur.route.id}|${cur.hub.fraction.toFixed(6)}`;
    if (visited.has(key)) continue;
    visited.add(key);

    // Record a completed path (but don't return — keep exploring alternatives)
    const rd = routeData.find((r) => r.route.id === cur.route.id);
    if (rd && rd.d && cur.hub.fraction < rd.d.fraction) {
      const completedLegs = cur.legs.map((leg) => ({ ...leg }));
      const lastLeg = completedLegs[completedLegs.length - 1];
      lastLeg.alightAt = {
        location_id: dest.locationId,
        lat: rd.d.snapped.lat, lng: rd.d.snapped.lng,
        fraction: rd.d.fraction, eta_offset_min: rd.d.etaOffsetMin,
        name: dest.name,
      };
      for (let i = 0; i < completedLegs.length - 1; i++) {
        completedLegs[i].alightAt = completedLegs[i + 1].boardAt;
      }
      const namedLegs = completedLegs.map((leg) => ({
        ...leg,
        route: { ...leg.route, ...routeNames(leg.route) },
      }));
      const sig = namedLegs.map((l) => l.route.id).join('|');
      if (!foundPaths.some((p) => p._sig === sig)) {
        foundPaths.push({
          _sig: sig,
          type: 'connecting',
          transfers: namedLegs.length - 1,
          legs: namedLegs,
          totalDurationMin:
            namedLegs.reduce((s, l) => s + (l.route.base_duration_min || 240), 0) +
            (namedLegs.length - 1) * MIN_TRANSFER_GAP_MIN,
        });
      }
    }

    for (const next of routeData) {
      if (next.route.id === cur.route.id) {
        for (const h of next.hubs) {
          if (h.fraction <= cur.hub.fraction) continue;
          const nk = `${next.route.id}|${h.fraction.toFixed(6)}`;
          if (visited.has(nk)) continue;
          const travelMin = Math.round(
            (next.route.base_duration_min || 240) * (h.fraction - cur.hub.fraction)
          );
          queue.push({
            route: next.route, hub: h,
            cost: cur.cost + travelMin,
            legs: cur.legs,
          });
        }
      } else {
        for (const h of next.hubs) {
          if (!samePhysical(cur.hub, h)) continue;
          const nk = `${next.route.id}|${h.fraction.toFixed(6)}`;
          if (visited.has(nk)) continue;
          if (cur.legs.length >= MAX_TRANSFERS + 1) continue;
          queue.push({
            route: next.route, hub: h,
            cost: cur.cost + MIN_TRANSFER_GAP_MIN,
            legs: [...cur.legs, { route: next.route, boardAt: h }],
          });
        }
      }
    }

    if (visited.size > MAX_STATES) break;
  }

  // Only paths requiring a real change of bus belong here.
  const multiLeg = foundPaths.filter((p) => p.transfers >= 1);
  multiLeg.sort((a, b) => {
    if (a.transfers !== b.transfers) return a.transfers - b.transfers;
    return a.totalDurationMin - b.totalDurationMin;
  });
  return multiLeg.slice(0, maxResults).map(({ _sig, totalDurationMin, ...p }) => p);
}

module.exports = { search, getRouteStopsInOrder, resolveEndpoint, locateOnRoute };
