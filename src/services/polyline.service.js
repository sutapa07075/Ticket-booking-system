// src/services/polyline.service.js
// Pure-JS polyline math. No dependencies.

function decodePolyline(encoded) {
  if (!encoded) return [];
  let index = 0, lat = 0, lng = 0;
  const path = [];
  while (index < encoded.length) {
    let b, shift = 0, result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0; result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;
    path.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return path;
}

const R = 6371000;
function haversineM(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat), lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function snapToSegment(P, A, B) {
  const ax = A.lng, ay = A.lat, bx = B.lng, by = B.lat, px = P.lng, py = P.lat;
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const snapped = { lat: ay + t * dy, lng: ax + t * dx };
  return { point: snapped, t, distFromA_m: haversineM(A, snapped) };
}

function snapToPolyline(polyline, P) {
  if (!polyline || polyline.length < 2) return null;
  let best = null, cumulative = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const A = polyline[i], B = polyline[i + 1];
    const { point, distFromA_m } = snapToSegment(P, A, B);
    const offset = haversineM(P, point);
    const along = cumulative + distFromA_m;
    if (!best || offset < best.offsetM) {
      best = { snapped: point, alongM: along, offsetM: offset, segmentIndex: i };
    }
    cumulative += haversineM(A, B);
  }
  return best;
}

function polylineLengthM(polyline) {
  let total = 0;
  for (let i = 0; i < polyline.length - 1; i++) total += haversineM(polyline[i], polyline[i + 1]);
  return total;
}

function fractionAlong(polyline, alongM) {
  const total = polylineLengthM(polyline);
  return total === 0 ? 0 : alongM / total;
}

// Standard Google polyline algorithm encoder — used as a fallback to build
// a straight-line-segment polyline (origin -> stops -> destination, in
// order) locally when the Routes API is unavailable, so route creation
// never hard-fails just because a live road-route call couldn't be made.
function encodePolyline(points) {
  let output = '';
  let prevLat = 0, prevLng = 0;
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    output += encodeSigned(lat - prevLat) + encodeSigned(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return output;
}

function encodeSigned(num) {
  let sgnNum = num << 1;
  if (num < 0) sgnNum = ~sgnNum;
  let out = '';
  while (sgnNum >= 0x20) {
    out += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  out += String.fromCharCode(sgnNum + 63);
  return out;
}

module.exports = { decodePolyline, encodePolyline, snapToSegment, snapToPolyline, polylineLengthM, fractionAlong, haversineM };