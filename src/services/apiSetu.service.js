const axios = require('axios');

/**
 * API Setu (apisetu.gov.in) sandbox integration for PAN / Aadhaar format
 * verification during driver KYC. Real sandbox access requires registering
 * as an approved API consumer, so this defaults to APISETU_MOCK_MODE=true
 * (basic format validation only, no network call) — see README §9.
 * Set APISETU_MOCK_MODE=false and fill in APISETU_* env vars to go live.
 */

const MOCK = (process.env.APISETU_MOCK_MODE || 'true') === 'true';

const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const AADHAAR_RE = /^[0-9]{12}$/;

async function verifyPan(panNumber, name) {
  if (!panNumber) return { verified: false, error: 'PAN number missing' };
  if (MOCK) {
    return { verified: PAN_RE.test(panNumber.toUpperCase()), mock: true };
  }
  try {
    const { data } = await axios.post(
      `${process.env.APISETU_BASE_URL}/pan/verify`,
      { pan: panNumber, name },
      { headers: { Authorization: `Bearer ${process.env.APISETU_API_KEY}` }, timeout: 6000 }
    );
    return { verified: !!data.valid, raw: data };
  } catch (e) {
    return { verified: false, error: e.message };
  }
}

async function verifyAadhaar(aadhaarNumber) {
  if (!aadhaarNumber) return { verified: false, error: 'Aadhaar number missing' };
  if (MOCK) {
    return { verified: AADHAAR_RE.test(aadhaarNumber), mock: true };
  }
  try {
    const { data } = await axios.post(
      `${process.env.APISETU_BASE_URL}/aadhaar/verify`,
      { aadhaar: aadhaarNumber },
      { headers: { Authorization: `Bearer ${process.env.APISETU_API_KEY}` }, timeout: 6000 }
    );
    return { verified: !!data.valid, raw: data };
  } catch (e) {
    return { verified: false, error: e.message };
  }
}

/**
 * Face-match between the PAN photo and Aadhaar/selfie. This is a stub —
 * wire in a real biometric provider (AWS Rekognition, Azure Face, etc.)
 * for production use. Always returns "needs manual review" in mock mode.
 */
async function faceMatch(panImageKey, aadhaarImageKey) {
  return { matched: null, note: 'Face-match not configured — manual review required.' };
}

module.exports = { verifyPan, verifyAadhaar, faceMatch };
