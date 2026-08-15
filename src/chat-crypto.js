// Lazy wrapper around @xdevplatform/chat-xdk + juicebox-sdk.
// Classic DM never imports this module's side effects: createChatSession is
// only called when transport=chat. Missing optional deps keep the Chat path
// dormant instead of crashing the plugin load.
import { readXDmEnv } from "./configured-state.js";
import {
  getUserPublicKeys,
  juiceboxConfigJson,
  loadRealmTokens,
  latestPublicKey,
  signingKeyEntry,
  prepToRequest,
  encryptPayloadToSendBody,
  initializeConversationKeys,
  fetchChatEvents,
} from "./chat-client.js";

export function chatPin() {
  return readXDmEnv().X_CHAT_PIN || "";
}

export function chatSigningKeyVersion(fallback = "1") {
  return readXDmEnv().X_CHAT_SIGNING_KEY_VERSION || fallback;
}

export function weakPinReason(pin) {
  const bytes = new TextEncoder().encode(String(pin ?? ""));
  if (bytes.length < 4) return "must be at least 4 characters";
  if (bytes.every((b) => b === bytes[0])) return "must not be a single repeated character";
  const allDigits = bytes.every((b) => b >= 0x30 && b <= 0x39);
  let ascending = true;
  let descending = true;
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] !== bytes[i - 1] + 1) ascending = false;
    if (bytes[i] !== bytes[i - 1] - 1) descending = false;
  }
  if (allDigits && (ascending || descending)) return "must not be a sequential run of digits";
  return null;
}

async function loadCreateChat() {
  try {
    const mod = await import("@xdevplatform/chat-xdk");
    if (typeof mod.createChat !== "function") {
      throw new Error("@xdevplatform/chat-xdk does not export createChat");
    }
    return mod.createChat;
  } catch (err) {
    throw new Error(
      "X Chat transport needs @xdevplatform/chat-xdk and juicebox-sdk. " +
        "Install them in the plugin directory (`npm install @xdevplatform/chat-xdk juicebox-sdk`), " +
        `then restart the gateway. Original error: ${err.message}`
    );
  }
}

export async function createChatSession({ botUserId, log = console } = {}) {
  const pin = chatPin();
  if (!pin) {
    throw new Error(
      "X Chat transport needs X_CHAT_PIN in ~/.openclaw/x-dm-keys.env " +
        "(Juicebox recovery PIN for the bot identity). Run tools/x-chat-register.mjs first."
    );
  }

  const ours = await getUserPublicKeys(botUserId);
  const configJson = juiceboxConfigJson(ours);
  if (!configJson) {
    throw new Error(
      "No juicebox_config on this account — the bot public key is not registered. " +
        "Run: node tools/x-chat-register.mjs --confirm"
    );
  }

  const realmTokens = loadRealmTokens(configJson);
  const createChat = await loadCreateChat();
  const chat = await createChat({
    juiceboxConfig: configJson,
    getAuthToken: async (realmId) => realmTokens.get(String(realmId).toLowerCase()) ?? "",
  });
  await chat.unlock(pin);

  const latest = latestPublicKey(ours);
  const version = chatSigningKeyVersion(latest?.public_key_version || "1");
  chat.setIdentity(botUserId, version);
  chat.setCacheKeys(true);

  const signingKeys = new Map();
  const ourEntry = signingKeyEntry(latest, botUserId);
  if (ourEntry) {
    signingKeys.set(botUserId, [ourEntry]);
    chat.setSigningKeys([ourEntry]);
  }

  log.info?.(`x-dm: chat session unlocked (signingKeyVersion=${version})`);
  return { chat, signingKeys, version, ourPublicKey: latest };
}

export function messageText(event) {
  if (!event) return null;
  const type = String(event.type ?? "").toLowerCase();
  if (type !== "message") return null;
  return event.content?.text ?? event.text ?? null;
}

export function eventType(event) {
  return String(event?.type ?? "").toLowerCase();
}

export async function ensureSigningKeys(session, senderIds, { log = console } = {}) {
  let changed = false;
  for (const raw of senderIds) {
    const senderId = String(raw ?? "");
    if (!senderId || session.signingKeys.has(senderId)) continue;
    try {
      const keys = await getUserPublicKeys(senderId);
      const entries = keys.map((pk) => signingKeyEntry(pk, senderId)).filter(Boolean);
      if (entries.length) {
        session.signingKeys.set(senderId, entries);
        changed = true;
      }
    } catch (err) {
      log.warn?.(`x-dm: public_keys fetch failed for ${senderId}: ${err.message}`);
    }
  }
  if (changed) {
    session.chat.setSigningKeys([...session.signingKeys.values()].flat());
  }
}

export function decryptBatch(session, eventsB64) {
  return session.chat.decryptEvents(eventsB64);
}

export function decryptOne(session, eventB64) {
  return session.chat.decryptEvent(eventB64);
}

export function encryptForSend(session, { conversationId, text, replyToEvent }) {
  const payload = replyToEvent
    ? session.chat.encryptReply({ conversationId, text, replyToEvent })
    : session.chat.encryptMessage({ conversationId, text });
  return encryptPayloadToSendBody(payload);
}

export async function ensureConversationKeys(session, recipientId, botUserId, { log = console } = {}) {
  // If the cache already has a key, encryptMessage succeeds. A throw means
  // we have never seen a KeyChange for this 1:1 and must initialize.
  try {
    session.chat.encryptMessage({ conversationId: recipientId, text: "." });
    return;
  } catch {
    /* initialize below */
  }

  await ensureSigningKeys(session, [recipientId], { log });
  const theirs = await getUserPublicKeys(recipientId);
  if (!theirs.length) {
    throw new Error(
      `recipient ${recipientId} has no X Chat public key — they have not enrolled in Chat`
    );
  }
  const theirPk = latestPublicKey(theirs);
  const ourPk = session.ourPublicKey;
  if (!ourPk?.public_key) {
    throw new Error("bot has no registered X Chat public key");
  }

  const prep = session.chat.prepareConversationKeyChange({
    publicKeys: [
      { userId: botUserId, publicKey: ourPk.public_key, keyVersion: ourPk.public_key_version },
      {
        userId: recipientId,
        publicKey: theirPk.public_key,
        keyVersion: theirPk.public_key_version,
      },
    ],
  });
  const body = prepToRequest(prep, ourPk.signing_public_key);
  await initializeConversationKeys(recipientId, body);
  // The KeyChange we just posted is what feeds the SDK cache. Pull it back
  // so the following encryptMessage can resolve the conversation key.
  try {
    const page = await fetchChatEvents(recipientId, { maxResults: 20 });
    const meta = page.data?.meta ?? {};
    const keyEvents = meta.conversation_key_events ?? meta.conversationKeyEvents ?? [];
    const raw = page.data?.data ?? [];
    const encoded = [
      ...keyEvents,
      ...raw.map((e) => e.encoded_event ?? e.encodedEvent).filter(Boolean),
    ];
    if (encoded.length) session.chat.decryptEvents(encoded);
  } catch (err) {
    log.warn?.(`x-dm: could not refresh Chat keys after init: ${err.message}`);
  }
  log.info?.(`x-dm: initialized Chat conversation keys with ${recipientId}`);
}
