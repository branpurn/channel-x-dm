// X API client for x-dm (OAuth 1.0a)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import OAuth from "oauth-1.0a";

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

// Lazily build and cache the OAuth signer from the env file. Returns null until
// all required keys exist, so the plugin can load and stay dormant before
// credentials are provided. Only caches on success → re-checks until configured,
// so writing the env file and restarting the gateway is enough to activate it.
let _signer = null;
function ensureSigner() {
  if (_signer) return _signer;
  const k = loadEnv();
  if (!k || REQUIRED.some((key) => !k[key])) return null;
  const oauth = new OAuth({
    consumer: { key: k.X_API_KEY, secret: k.X_API_SECRET },
    signature_method: "HMAC-SHA1",
    hash_function(base, key) {
      return crypto.createHmac("sha1", key).update(base).digest("base64");
    },
  });
  _signer = { creds: k, oauth, token: { key: k.X_ACCESS_TOKEN, secret: k.X_ACCESS_SECRET } };
  return _signer;
}

// True once valid X API credentials exist on disk.
export function isConfigured() {
  return ensureSigner() !== null;
}

// Which required keys are still missing (for actionable setup messages).
export function missingKeys() {
  const k = loadEnv() ?? {};
  return REQUIRED.filter((key) => !k[key]);
}

// The bot's own numeric user id (X_USER_ID), for loop protection. Empty string
// until configured or if X_USER_ID is unset.
export function botUserId() {
  return ensureSigner()?.creds.X_USER_ID ?? "";
}

async function signedFetch(url, method, body) {
  const s = ensureSigner();
  if (!s) {
    throw new Error(
      `x-dm not configured: create ${ENV_PATH} with your X API keys (run setup.sh).`
    );
  }
  const auth = s.oauth.toHeader(s.oauth.authorize({ url, method }, s.token));
  return fetch(url, {
    method,
    headers: { ...auth, "Content-Type": "application/json" },
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
