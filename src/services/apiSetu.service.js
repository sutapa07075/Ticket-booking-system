const axios = require('axios');

/**
 * API Setu (https://www.apisetu.gov.in/) sandbox integration for demo/student use.
 *
 * IMPORTANT: getting real API Setu sandbox access requires registering as a
 * government API consumer, which is a multi-step approval process, not
 * something you get instantly by signing up. For a student project on a
 * deadline, that's usually not realistic.
 *
 * MOCK MODE: set APISETU_MOCK_MODE=true in .env (this is now the default in
 * .env.example) to skip the real network call entirely and simulate a
 * verification response instead. This lets you test the full driver → bus →
 * route → trip → booking flow end-to-end without needing real government API
 * credentials. Basic sanity checks (PAN format, Aadhaar length) still run, so
 * mock mode isn't a rubber stamp — obviously malformed input still fails.
 * Swap in real credentials + set APISETU_MOCK_MODE=false whenever you do get
 * real sandbox access; no other code changes needed.
 */

const BASE = process.env.APISETU_BASE_URL;
const CLIENT_ID = process.env.APISETU_CLIENT_ID;
const CLIENT_SECRET = process.env.APISETU_CLIENT_SECRET;
const MOCK_MODE = process.env.APISETU_MOCK_MODE === 'true';

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAAR_REGEX = /^[0-9]{12}$/;

async function verifyPan(panNumber, nameOnPan) {
  if (MOCK_MODE) {
    await new Promise((r) => setTimeout(r, 300)); // simulate network latency
    const valid = PAN_REGEX.test((panNumber || '').toUpperCase());
    return { verified: valid, raw: { mock: true, reason: valid ? 'format valid' : 'PAN format invalid (expect ABCDE1234F)' } };
  }
  try {
    const { data } = await axios.post(
      `${BASE}/pan/verify`,
      { pan_number: panNumber, name: nameOnPan },
      { headers: { 'x-client-id': CLIENT_ID, 'x-client-secret': CLIENT_SECRET } }
    );
    return { verified: !!data?.valid, raw: data };
  } catch (e) {
    console.error('[apisetu] PAN verify failed:', e.message);
    return { verified: false, error: e.message };
  }
}

async function verifyAadhaar(aadhaarNumber) {
  if (MOCK_MODE) {
    await new Promise((r) => setTimeout(r, 300));
    const valid = AADHAAR_REGEX.test((aadhaarNumber || '').replace(/\s/g, ''));
    return { verified: valid, raw: { mock: true, reason: valid ? 'format valid' : 'Aadhaar must be exactly 12 digits' } };
  }
  try {
    const { data } = await axios.post(
      `${BASE}/aadhaar/verify`,
      { aadhaar_number: aadhaarNumber },
      { headers: { 'x-client-id': CLIENT_ID, 'x-client-secret': CLIENT_SECRET } }
    );
    return { verified: !!data?.valid, raw: data };
  } catch (e) {
    console.error('[apisetu] Aadhaar verify failed:', e.message);
    return { verified: false, error: e.message };
  }
}

/**
 * Face match between the PAN photo and the Aadhaar/selfie photo.
 * A real system would use a proper face-match API (e.g. AWS Rekognition,
 * Azure Face, or a UIDAI-licensed provider). This is a stub interface so
 * you can plug one in without changing the calling code.
 */
async function faceMatch(imageUrlA, imageUrlB) {
  if (MOCK_MODE) {
    return { matched: true, confidence: 0.97, note: 'mock_mode — not a real face match' };
  }
  return { matched: null, confidence: null, note: 'manual_review_required_demo_mode' };
}

module.exports = { verifyPan, verifyAadhaar, faceMatch, MOCK_MODE };
