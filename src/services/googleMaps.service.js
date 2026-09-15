const axios = require('axios');

const KEY = process.env.GOOGLE_MAPS_API_KEY;

/**
 * Rewritten to use only APIs available on Google's free "Maps Demo Key"
 * (no billing account required): Places API (New), Geocoding API v4, and
 * the Routes API's "Compute Routes". The legacy Places Autocomplete,
 * Place Details, Directions, and Distance Matrix endpoints this file used
 * to call are NOT on the demo key's supported list and will fail on it.
 * If you later attach billing to a real key, this same code keeps working —
 * the New Places API and Routes API are Google's current, recommended APIs
 * either way.
 */

const PLACES_BASE = 'https://places.googleapis.com/v1';
const ROUTES_BASE = 'https://routes.googleapis.com';

/**
 * Location autocomplete ("hinting the real location" as the user types),
 * via Places API (New) — Autocomplete (New).
 */
async function autocomplete(input, sessionToken) {
  const { data } = await axios.post(
    `${PLACES_BASE}/places:autocomplete`,
    {
      input,
      includedRegionCodes: ['in'],
      sessionToken,
    },
    { headers: { 'X-Goog-Api-Key': KEY, 'Content-Type': 'application/json' } }
  );

  const suggestions = data.suggestions || [];
  return suggestions
    .filter((s) => s.placePrediction)
    .map((s) => {
      const p = s.placePrediction;
      return {
        place_id: p.placeId,
        description: p.text?.text,
        main_text: p.structuredFormat?.mainText?.text,
        secondary_text: p.structuredFormat?.secondaryText?.text,
      };
    });
}

/**
 * Resolve a place_id to lat/lng + formatted address, via Places API (New)
 * Place Details.
 */
async function placeDetails(placeId) {
  const { data } = await axios.get(`${PLACES_BASE}/places/${placeId}`, {
    headers: {
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,addressComponents',
    },
  });
  if (!data || !data.location) return null;

  const city = data.addressComponents?.find((c) => c.types.includes('locality'))?.longText;
  const state = data.addressComponents?.find((c) => c.types.includes('administrative_area_level_1'))?.longText;

  return {
    place_id: placeId,
    name: data.displayName?.text,
    formatted_address: data.formattedAddress,
    lat: data.location.latitude,
    lng: data.location.longitude,
    city,
    state,
  };
}

/**
 * Road route between two coordinates, via the Routes API "Compute Routes"
 * (the demo-key-supported replacement for the legacy Directions API).
 * Returns distance, duration, and an encoded polyline the frontend can
 * decode and draw directly — no legacy DirectionsService/Renderer needed.
 */
async function computeRoute(originLatLng, destLatLng) {
  const { data } = await axios.post(
    `${ROUTES_BASE}/directions/v2:computeRoutes`,
    {
      origin: { location: { latLng: { latitude: originLatLng.lat, longitude: originLatLng.lng } } },
      destination: { location: { latLng: { latitude: destLatLng.lat, longitude: destLatLng.lng } } },
      travelMode: 'DRIVE',
    },
    {
      headers: {
        'X-Goog-Api-Key': KEY,
        'Content-Type': 'application/json',
        'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
      },
    }
  );

  const route = data.routes?.[0];
  if (!route) return null;

  return {
    distance_km: route.distanceMeters / 1000,
    duration_min: Math.round(parseInt(route.duration) / 60), // duration comes back like "1234s"
    encoded_polyline: route.polyline?.encodedPolyline || null,
  };
}

module.exports = { autocomplete, placeDetails, computeRoute };
