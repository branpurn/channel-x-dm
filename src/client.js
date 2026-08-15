// X API client for classic (unencrypted) DMs — OAuth 1.0a HMAC-SHA1.
// Chat transport lives in chat-client.js and talks to /2/chat/*.
import { readXDmEnv, X_DM_ENV_PATH, X_DM_REQUIRED_KEYS as REQUIRED } from "./configured-state.js";
import { ensureCreds, signedFetch, rateLimitInfo } from "./oauth.js";

const ENV_PATH = X_DM_ENV_PATH;

// Hard ceiling on a single DM. X rejects oversized payloads outright, so both
// the inbound reply path and the outbound send path truncate here rather than
// each remembering to do it (they previously disagreed: inbound sliced, the
// /send path did not, so a long send got a 400 instead of a trimmed message).
export const MAX_DM_CHARS = 9000;

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
    ...rateLimitInfo(res),
  };
}

export { ENV_PATH };
