// OAuth 1.0a HMAC-SHA1 + shared fetch for X API calls.
// Zero external dependencies. Base-string construction verified against
// Twitter's published OAuth 1.0a test vector.
import crypto from "node:crypto";
import { readXDmEnv, X_DM_ENV_PATH, X_DM_REQUIRED_KEYS as REQUIRED } from "./configured-state.js";

const ENV_PATH = X_DM_ENV_PATH;

// Network calls must not hang forever: poll() awaits this inline, so one stalled
// socket would silently freeze the poller for the life of the process. Node's
// fetch has no default timeout.
export const FETCH_TIMEOUT_MS = 30000;

let _creds = null;
export function ensureCreds() {
  if (_creds) return _creds;
  const k = readXDmEnv();
  if (REQUIRED.some((key) => !k[key])) return null;
  _creds = k;
  return _creds;
}

export function resetCredsCache() {
  _creds = null;
}

// RFC-3986 percent-encoding (encodeURIComponent plus the four chars it omits).
export function pctEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// Build the OAuth 1.0a Authorization header. Signed params = the URL's query
// params + the oauth_* params. (JSON request bodies aren't form-encoded, so
// they're correctly excluded from the signature.) Note: unlike the oauth-1.0a
// package, this DOES fold URL query params into the signature — which X requires.
export function authHeader(method, url, creds) {
  const u = new URL(url);
  const oauthParams = {
    oauth_consumer_key: creds.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const all = { ...oauthParams };
  for (const [k, v] of u.searchParams) all[k] = v;
  const paramString = Object.entries(all)
    .map(([k, v]) => [pctEncode(k), pctEncode(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const baseUrl = `${u.protocol}//${u.host}${u.pathname}`;
  const baseString = [method.toUpperCase(), pctEncode(baseUrl), pctEncode(paramString)].join("&");
  const signingKey = `${pctEncode(creds.X_API_SECRET)}&${pctEncode(creds.X_ACCESS_SECRET)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");
  return (
    "OAuth " +
    Object.entries({ ...oauthParams, oauth_signature: signature })
      .map(([k, v]) => `${pctEncode(k)}="${pctEncode(v)}"`)
      .join(", ")
  );
}

export async function signedFetch(url, method, body) {
  const creds = ensureCreds();
  if (!creds) {
    throw new Error(
      `x-dm not configured: create ${ENV_PATH} with your X API keys (run onboarding).`
    );
  }
  return fetch(url, {
    method,
    headers: {
      Authorization: authHeader(method, url, creds),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// Chat examples prefer an OAuth 2.0 user-context bearer (dm.read + dm.write).
// OAuth 1.0a user context is also accepted by the Chat routes. Prefer the
// dedicated OAuth2 token when present so a classic OAuth 1.0a X_ACCESS_TOKEN
// is never sent as a bearer.
export function oauth2AccessToken() {
  return ensureCreds()?.X_OAUTH2_ACCESS_TOKEN || "";
}

export async function apiFetch(url, method, body) {
  const bearer = oauth2AccessToken();
  if (bearer) {
    return fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  }
  return signedFetch(url, method, body);
}

export function rateLimitInfo(res) {
  return {
    limit: res.headers.get("x-rate-limit-limit"),
    remaining: res.headers.get("x-rate-limit-remaining"),
    reset: res.headers.get("x-rate-limit-reset"),
  };
}
