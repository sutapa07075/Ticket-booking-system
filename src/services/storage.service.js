const axios = require('axios');

/**
 * Minimal Backblaze B2 uploader using the native B2 API (no SDK dependency).
 * Used to store KYC documents: PAN image, Aadhaar image, driver selfie.
 * These are sensitive documents - bucket should be PRIVATE, not public.
 */

let authCache = null; // { apiUrl, authToken, downloadUrl, expiresAt }

async function authorize() {
  if (authCache && authCache.expiresAt > Date.now()) return authCache;

  const keyId = process.env.B2_KEY_ID;
  const appKey = process.env.B2_APP_KEY;
  const credentials = Buffer.from(`${keyId}:${appKey}`).toString('base64');

  const { data } = await axios.get(
    'https://api.backblazeb2.com/b2api/v3/b2_authorize_account',
    { headers: { Authorization: `Basic ${credentials}` } }
  );

  authCache = {
    apiUrl: data.apiInfo.storageApi.apiUrl,
    authToken: data.authorizationToken,
    downloadUrl: data.apiInfo.storageApi.downloadUrl,
    expiresAt: Date.now() + 20 * 60 * 60 * 1000, // ~20h validity
  };
  return authCache;
}

async function getUploadUrl() {
  const auth = await authorize();
  const { data } = await axios.post(
    `${auth.apiUrl}/b2api/v3/b2_get_upload_url`,
    { bucketId: process.env.B2_BUCKET_ID },
    { headers: { Authorization: auth.authToken } }
  );
  return data; // { uploadUrl, authorizationToken }
}

/**
 * Upload a buffer (e.g. from multer memoryStorage) and return the storage key.
 */
async function uploadFile(buffer, fileName, mimeType) {
  const { uploadUrl, authorizationToken } = await getUploadUrl();
  const crypto = require('crypto');
  const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');

  const key = `kyc/${Date.now()}-${fileName}`;

  await axios.post(uploadUrl, buffer, {
    headers: {
      Authorization: authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': mimeType || 'b2/x-auto',
      'X-Bz-Content-Sha1': sha1,
    },
  });

  return key;
}

async function getSignedDownloadUrl(key, validSeconds = 3600) {
  const auth = await authorize();
  const { data } = await axios.post(
    `${auth.apiUrl}/b2api/v3/b2_get_download_authorization`,
    {
      bucketId: process.env.B2_BUCKET_ID,
      fileNamePrefix: key,
      validDurationInSeconds: validSeconds,
    },
    { headers: { Authorization: auth.authToken } }
  );
  return `${auth.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${key}?Authorization=${data.authorizationToken}`;
}

module.exports = { uploadFile, getSignedDownloadUrl };
