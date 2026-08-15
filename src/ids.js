// Identifier helpers shared by classic DM and X Chat transports.
import { CHANNEL_ID } from "./transport.js";

export function normalizeXId(raw) {
  return String(raw ?? "")
    .trim()
    .replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "");
}

export function looksLikeXId(raw) {
  return /^\d{1,25}$/.test(normalizeXId(raw));
}

// Chat REST paths use hyphen-separated 1:1 ids (or a bare recipient id).
// Events and message signatures use the colon form. Groups are `g…`.
export function pathConversationId(id) {
  return String(id ?? "").replaceAll(":", "-");
}

export function canonicalConversationId(id) {
  return String(id ?? "").replaceAll("-", ":");
}

export function isGroupConversationId(id) {
  return /^g/i.test(String(id ?? "").trim());
}

// The other participant in a 1:1. Accepts a recipient user id, hyphen form,
// or colon form. Returns null for groups (not supported on either transport).
export function peerFromConversation(conversationId, botUserId) {
  const raw = String(conversationId ?? "").trim();
  if (!raw || isGroupConversationId(raw)) return null;
  if (/^\d+$/.test(raw)) return raw;
  const parts = raw.split(/[-:]/).filter(Boolean);
  if (parts.length === 2) {
    const bot = String(botUserId ?? "");
    if (bot && parts[0] === bot) return parts[1];
    if (bot && parts[1] === bot) return parts[0];
    return parts[0];
  }
  return null;
}

// Numeric (BigInt) comparison of snowflake-style string IDs. true if a > b.
// Falls back to string compare when an id isn't numeric (Chat message_ids
// are not guaranteed to be snowflakes).
export function idGreater(a, b) {
  if (a == null || b == null) return Boolean(a && !b);
  try {
    if (/^\d+$/.test(String(a)) && /^\d+$/.test(String(b))) {
      return BigInt(a) > BigInt(b);
    }
  } catch {
    /* fall through */
  }
  return String(a) > String(b);
}

export function newestId(arr, pick = (e) => e.id) {
  return arr.reduce((max, e) => {
    const id = pick(e);
    if (id == null || id === "") return max;
    return max === null || idGreater(id, max) ? id : max;
  }, null);
}
