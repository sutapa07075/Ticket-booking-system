const db = require('../db/init');

/**
 * Finds ways to travel from originLocationId to destLocationId on a given date.
 * 1) Direct: a single active route whose origin/destination (or any two stops
 *    in order) match.
 * 2) Connecting (1 transfer): route A ends/stops at some hub location X,
 *    and route B starts/stops at X and reaches the destination -> suggest
 *    "board bus A, get down at X, change to bus B".
 *
 * This is a simple graph search suitable for a moderate number of routes;
 * for a large network you'd precompute a route graph / use a real routing engine.
 */

function getRouteStopsInOrder(routeId) {
  const route = db.prepare(`SELECT * FROM routes WHERE id = ?`).get(routeId);
  const stops = db
    .prepare(`SELECT * FROM route_stops WHERE route_id = ? ORDER BY stop_order`)
    .all(routeId);
  // Build full ordered list: origin -> stops... -> destination
  return [
    { location_id: route.origin_location_id, eta_offset_min: 0 },
    ...stops,
    { location_id: route.destination_location_id, eta_offset_min: route.base_duration_min },
  ];
}

function activeRoutes() {
  return db.prepare(`SELECT * FROM routes WHERE is_cancelled = 0`).all();
}

function findDirectRoutes(originId, destId) {
  const routes = activeRoutes();
  const matches = [];

  for (const route of routes) {
    const ordered = getRouteStopsInOrder(route.id);
    const originIdx = ordered.findIndex((s) => s.location_id === originId);
    const destIdx = ordered.findIndex((s) => s.location_id === destId);
    if (originIdx !== -1 && destIdx !== -1 && originIdx < destIdx) {
      matches.push({
        type: 'direct',
        route,
        boardAt: ordered[originIdx],
        alightAt: ordered[destIdx],
      });
    }
  }
  return matches;
}

function findConnectingRoutes(originId, destId, maxTransfers = 1) {
  const routes = activeRoutes();
  const results = [];

  // routes that can be boarded from originId
  const legOneCandidates = routes
    .map((r) => ({ route: r, ordered: getRouteStopsInOrder(r.id) }))
    .filter((r) => r.ordered.some((s) => s.location_id === originId));

  for (const leg1 of legOneCandidates) {
    const boardIdx = leg1.ordered.findIndex((s) => s.location_id === originId);
    // every stop after boarding on leg1 is a possible transfer hub
    for (let i = boardIdx + 1; i < leg1.ordered.length; i++) {
      const hub = leg1.ordered[i].location_id;
      if (hub === destId) continue; // that would've been a direct route already

      const legTwoCandidates = routes
        .filter((r) => r.id !== leg1.route.id)
        .map((r) => ({ route: r, ordered: getRouteStopsInOrder(r.id) }))
        .filter((r) => r.ordered.some((s) => s.location_id === hub));

      for (const leg2 of legTwoCandidates) {
        const hubIdxLeg2 = leg2.ordered.findIndex((s) => s.location_id === hub);
        const destIdxLeg2 = leg2.ordered.findIndex((s) => s.location_id === destId);
        if (destIdxLeg2 !== -1 && hubIdxLeg2 < destIdxLeg2) {
          results.push({
            type: 'connecting',
            transfers: 1,
            legs: [
              { route: leg1.route, boardAt: leg1.ordered[boardIdx], alightAt: leg1.ordered[i] },
              { route: leg2.route, boardAt: leg2.ordered[hubIdxLeg2], alightAt: leg2.ordered[destIdxLeg2] },
            ],
            changeAtLocationId: hub,
          });
        }
      }
    }
  }

  return results;
}

function search(originId, destId) {
  const direct = findDirectRoutes(originId, destId);
  const connecting = direct.length > 0 ? [] : findConnectingRoutes(originId, destId);
  return { direct, connecting };
}

module.exports = { search, getRouteStopsInOrder };
