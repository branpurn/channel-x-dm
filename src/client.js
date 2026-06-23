// X API client for x-dm (OAuth 1.0a)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import OAuth from "oauth-1.0a";

function loadCreds() {
  const path = `${os.homedir()}/.openclaw/x-dm-keys.env`;
  const k = {};
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && t.includes("=")) {
      const i = t.indexOf("=");
      k[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
  return k;
}

const creds = loadCreds();

const oauth = new OAuth({
  consumer: { key: creds.X_API_KEY, secret: creds.X_API_SECRET },
  signature_method: "HMAC-SHA1",
  hash_function(base, key) {
    return crypto.createHmac("sha1", key).update(base).digest("base64");
  },
});

const token = { key: creds.X_ACCESS_TOKEN, secret: creds.X_ACCESS_SECRET };

async function signedFetch(url, method, body) {
  const auth = oauth.toHeader(oauth.authorize({ url, method }, token));
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
