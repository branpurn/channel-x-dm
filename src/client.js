// X API client for x-dm — OAuth 1.0a HMAC-SHA1, signed inline with node:crypto.
// Zero external dependencies, so --link/git/clawhub/npm installs all work with no
// npm-install step. Base-string construction verified against Twitter's published
// OAuth 1.0a test vector.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

const ENV_PATH = `${os.homedir()}/.openclaw/x-dm-keys.env`;
const REQUIRED = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];

// Parse the key=value env file. Returns null if it doesn't exist, so importing
// this module NEVER throws on a fresh install where setup hasn't run yet.
function loadEnv() {
  let text;
  try {
    text = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    return null;
  }
  const k = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && t.includes("=")) {
      const i = t.indexOf("=");
      k[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
  return k;
}

// Lazily load and cache the credentials from the env file. Returns null until all
// required keys exist, so the plugin can load and stay dormant before credentials
// are provided. Only caches on success → re-checks until configured, so writing
// the env file and restarting the gateway is enough to activate it.
let _creds = null;
function ensureCreds() {
  if (_creds) return _creds;
  const k = loadEnv();
  if (!k || REQUIRED.some((key) => !k[key])) return null;
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
  const k = loadEnv() ?? {};
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
  });
}

// Send a DM to a numeric recipient id (creates a conversation if one doesn't exist).
export async function sendDm(recipientId, text) {
  const url = `https://api.x.com/2/dm_conversations/with/${recipientId}/messages`;
  const res = await signedFetch(url, "POST", { text });
  if (!res.ok) throw new Error(`sendDm ${res.status}: ${await res.text()}`);
  return res.json();
}

// Fetch recent DM events. Returns { data, limit, remaining }.
// Inbound is only visible for UNENCRYPTED conversations (see README).
export async function fetchDmEvents() {
  const url =
    "https://api.x.com/2/dm_events?dm_event.fields=id,text,event_type,sender_id,created_at,dm_conversation_id";
  const res = await signedFetch(url, "GET");
  if (!res.ok) throw new Error(`fetchDmEvents ${res.status}: ${await res.text()}`);
  return {
    data: await res.json(),
    limit: res.headers.get("x-rate-limit-limit"),
    remaining: res.headers.get("x-rate-limit-remaining"),
  };
}
