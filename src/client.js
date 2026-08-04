// X API client for x-dm — OAuth 1.0a HMAC-SHA1, signed inline with node:crypto.
// Zero external dependencies, so --link/git/clawhub/npm installs all work with no
// npm-install step. Base-string construction verified against Twitter's published
// OAuth 1.0a test vector.
import crypto from "node:crypto";
// Single source of truth for env parsing + the required-key list. This module
// used to carry its own copy of both; they drifted apart by definition since
// nothing kept them in sync, and this one is the copy that gates activation.
import { readXDmEnv, X_DM_ENV_PATH, X_DM_REQUIRED_KEYS as REQUIRED } from "./configured-state.js";

const ENV_PATH = X_DM_ENV_PATH;

// Hard ceiling on a single DM. X rejects oversized payloads outright, so both
// the inbound reply path and the outbound send path truncate here rather than
// each remembering to do it (they previously disagreed: inbound sliced, the
// /send path did not, so a long send got a 400 instead of a trimmed message).
const MAX_DM_CHARS = 9000;

// Network calls must not hang forever: poll() awaits this inline, so one stalled
// socket would silently freeze the poller for the life of the process. Node's
// fetch has no default timeout.
const FETCH_TIMEOUT_MS = 30000;

// Lazily load and cache the credentials from the env file. Returns null until all
// required keys exist, so the plugin can load and stay dormant before credentials
// are provided. Only caches on success → re-checks until configured, so writing
// the env file and restarting the gateway is enough to activate it.
let _creds = null;
function ensureCreds() {
  if (_creds) return _creds;
  const k = readXDmEnv();
  if (REQUIRED.some((key) => !k[key])) return null;
  _creds = k;
  return _creds;
}

// RFC-3986 percent-encoding (encodeURIComponent plus the four chars it omits).
function pctEncode(str) {
  return encodeURIComponent(String(str)).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// Build the OAuth 1.0a Authorization header. Signed params = the URL's query
// params + the oauth_* params. (JSON request bodies aren't form-encoded, so
// they're correctly excluded from the signature.) Note: unlike the oauth-1.0a
// package, this DOES fold URL query params into the signature — which X requires.
function authHeader(method, url, creds) {
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

// True once valid X API credentials exist on disk.
export function isConfigured() {
  return ensureCreds() !== null;
}

// Which required keys are still missing (for actionable setup messages).
export function missingKeys() {
  const k = readXDmEnv();
  return REQUIRED.filter((key) => !k[key]);
}

// The bot's own numeric user id (X_USER_ID), for loop protection. Empty string
// until configured or if X_USER_ID is unset.
export function botUserId() {
  return ensureCreds()?.X_USER_ID ?? "";
}

async function signedFetch(url, method, body) {
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

// Send a DM to a numeric recipient id (creates a conversation if one doesn't exist).
export async function sendDm(recipientId, text) {
  const url = `https://api.x.com/2/dm_conversations/with/${recipientId}/messages`;
  const res = await signedFetch(url, "POST", { text: String(text ?? "").slice(0, MAX_DM_CHARS) });
  if (!res.ok) throw new Error(`sendDm ${res.status}: ${await res.text()}`);
  return res.json();
}

// Fetch recent DM events. Returns { data, limit, remaining, reset }.
// Inbound is only visible for UNENCRYPTED conversations (see README).
//
// max_results is pinned to the API maximum. A single page is still all we read:
// with a 15-request/15-minute budget, chasing next_token would spend the very
// headroom the poller needs, so we buy margin with page size instead. A burst
// larger than one full page between polls can still be missed.
export async function fetchDmEvents() {
  const url =
    "https://api.x.com/2/dm_events?max_results=100" +
    "&dm_event.fields=id,text,event_type,sender_id,created_at,dm_conversation_id";
  const res = await signedFetch(url, "GET");
  if (!res.ok) throw new Error(`fetchDmEvents ${res.status}: ${await res.text()}`);
  return {
    data: await res.json(),
    limit: res.headers.get("x-rate-limit-limit"),
    remaining: res.headers.get("x-rate-limit-remaining"),
    // Epoch seconds when the window rolls over; lets the poller sleep out a
    // exhausted budget instead of hammering 429s.
    reset: res.headers.get("x-rate-limit-reset"),
  };
}
