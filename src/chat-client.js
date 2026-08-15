// X Chat API client — /2/chat/* and /2/users/:id/public_keys.
// Auth: OAuth 2.0 user-context bearer when X_OAUTH2_ACCESS_TOKEN is set,
// otherwise the same OAuth 1.0a user context as classic DMs. Both are
// accepted by the Chat routes.
import { apiFetch, rateLimitInfo } from "./oauth.js";
import { pathConversationId } from "./ids.js";

const BASE = "https://api.x.com";

export class ChatHttpError extends Error {
  constructor(op, status, body, resetEpoch = null) {
    super(`${op} ${status}: ${body}`);
    this.name = "ChatHttpError";
    this.status = status;
    this.body = body;
    this.resetEpoch = resetEpoch;
  }
}

async function chatFetch(op, url, method, body) {
  const res = await apiFetch(url, method, body);
  if (!res.ok) {
    const text = await res.text();
    const reset = res.headers.get("x-user-limit-24hour-reset") || res.headers.get("x-rate-limit-reset");
    throw new ChatHttpError(op, res.status, text, reset ? Number(reset) : null);
  }
  const text = await res.text();
  return {
    data: text ? JSON.parse(text) : {},
    ...rateLimitInfo(res),
  };
}

export function latestPublicKey(items) {
  const list = Array.isArray(items) ? items : items ? [items] : [];
  if (!list.length) return null;
  const versionOf = (d) => Number(d.public_key_version ?? d.publicKeyVersion ?? 0);
  return list.reduce((best, d) => (versionOf(d) >= versionOf(best) ? d : best), list[0]);
}

export function normalizePublicKey(pk, userId) {
  if (!pk) return null;
  return {
    user_id: String(userId ?? pk.user_id ?? pk.userId ?? ""),
    public_key: pk.public_key ?? pk.publicKey ?? "",
    signing_public_key: pk.signing_public_key ?? pk.signingPublicKey ?? "",
    identity_public_key_signature:
      pk.identity_public_key_signature ?? pk.identityPublicKeySignature ?? "",
    public_key_version: String(pk.public_key_version ?? pk.publicKeyVersion ?? ""),
    juicebox_config: pk.juicebox_config ?? pk.juiceboxConfig ?? null,
  };
}

export function signingKeyEntry(pk, userId) {
  const n = normalizePublicKey(pk, userId);
  if (!n) return null;
  return {
    userId: n.user_id,
    publicKeyVersion: n.public_key_version,
    publicKey: n.signing_public_key,
    identityPublicKey: n.public_key,
    identityPublicKeySignature: n.identity_public_key_signature,
  };
}

// Map a chat-xdk prepareConversationKeyChange result into the OpenAPI
// snake_case body for POST /2/chat/conversations/{id}/keys.
export function prepToRequest(prep, signingPublicKey) {
  const version = prep.conversationKeyVersion ?? prep.conversation_key_version;
  const keys = prep.participantKeys ?? prep.participant_keys ?? [];
  const sigs = prep.actionSignatures ?? prep.action_signatures ?? [];
  return {
    conversation_key_version: version,
    conversation_participant_keys: keys.map((pk) => ({
      user_id: String(pk.userId ?? pk.user_id ?? ""),
      encrypted_conversation_key: pk.encryptedKey ?? pk.encrypted_key ?? pk.encryptedConversationKey,
      public_key_version: String(pk.publicKeyVersion ?? pk.public_key_version ?? ""),
    })),
    action_signatures: sigs.map((sig) => ({
      message_id: sig.messageId ?? sig.message_id,
      encoded_message_event_detail: sig.encodedMessageEventDetail ?? sig.encoded_message_event_detail,
      ...(sig.signaturePayload || sig.signature_payload
        ? { signature_payload: sig.signaturePayload ?? sig.signature_payload }
        : {}),
      message_event_signature: {
        signature: sig.signature ?? sig.messageEventSignature?.signature,
        signature_version: sig.signatureVersion ?? sig.signature_version ?? sig.messageEventSignature?.signatureVersion,
        public_key_version: sig.publicKeyVersion ?? sig.public_key_version ?? sig.messageEventSignature?.publicKeyVersion,
        signing_public_key: signingPublicKey,
      },
    })),
  };
}

export function encryptPayloadToSendBody(payload) {
  return {
    message_id: payload.messageId ?? payload.message_id,
    encoded_message_create_event: payload.encryptedContent ?? payload.encoded_message_create_event,
    encoded_message_event_signature: payload.encodedEventSignature ?? payload.encoded_message_event_signature,
    ...(payload.conversationToken || payload.conversation_token
      ? { conversation_token: payload.conversationToken ?? payload.conversation_token }
      : {}),
  };
}

export async function fetchChatConversations({ maxResults = 100, paginationToken } = {}) {
  const u = new URL(`${BASE}/2/chat/conversations`);
  u.searchParams.set("max_results", String(maxResults));
  u.searchParams.set("chat_conversation.fields", "id,type,participant_ids");
  if (paginationToken) u.searchParams.set("pagination_token", paginationToken);
  return chatFetch("fetchChatConversations", u.toString(), "GET");
}

export async function fetchChatEvents(conversationId, { maxResults = 50, paginationToken } = {}) {
  const id = encodeURIComponent(pathConversationId(conversationId));
  const u = new URL(`${BASE}/2/chat/conversations/${id}/events`);
  u.searchParams.set("max_results", String(maxResults));
  u.searchParams.set(
    "chat_message_event.fields",
    "id,sender_id,created_at_msec,conversation_id,encoded_event,sequence_id"
  );
  if (paginationToken) u.searchParams.set("pagination_token", paginationToken);
  return chatFetch("fetchChatEvents", u.toString(), "GET");
}

export async function sendChatEncrypted(conversationId, body) {
  const id = encodeURIComponent(pathConversationId(conversationId));
  return chatFetch(
    "sendChatMessage",
    `${BASE}/2/chat/conversations/${id}/messages`,
    "POST",
    body
  );
}

export async function initializeConversationKeys(conversationId, body) {
  const id = encodeURIComponent(pathConversationId(conversationId));
  return chatFetch(
    "initializeConversationKeys",
    `${BASE}/2/chat/conversations/${id}/keys`,
    "POST",
    body
  );
}

export async function getUserPublicKeys(userId) {
  const { data } = await chatFetch(
    "getUserPublicKeys",
    `${BASE}/2/users/${encodeURIComponent(userId)}/public_keys`,
    "GET"
  );
  const items = data?.data ?? [];
  return (Array.isArray(items) ? items : [items]).filter(Boolean).map((pk) => normalizePublicKey(pk, userId));
}

export async function addUserPublicKey(userId, payload) {
  return chatFetch(
    "addUserPublicKey",
    `${BASE}/2/users/${encodeURIComponent(userId)}/public_keys`,
    "POST",
    payload
  );
}

export function juiceboxConfigJson(publicKeys) {
  const latest = latestPublicKey(publicKeys);
  const cfg = latest?.juicebox_config;
  if (!cfg) return null;
  return typeof cfg === "string" ? cfg : JSON.stringify(cfg);
}

export function loadRealmTokens(configJson) {
  const tokens = new Map();
  if (!configJson) return tokens;
  const parsed = typeof configJson === "string" ? JSON.parse(configJson) : configJson;
  for (const entry of parsed.token_map ?? parsed.tokenMap ?? []) {
    const realm = String(entry?.key ?? "").toLowerCase();
    const token = entry?.value?.token;
    if (realm && typeof token === "string") tokens.set(realm, token);
  }
  return tokens;
}
