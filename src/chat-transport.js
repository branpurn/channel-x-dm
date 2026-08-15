import os from "node:os";
import { MAX_DM_CHARS } from "./client.js";
import { dispatchInbound } from "./dispatch.js";
import { idGreater, newestId, peerFromConversation, isGroupConversationId, canonicalConversationId } from "./ids.js";
import { loadJsonState, saveJsonState, sleep, awaitAbort } from "./poll-utils.js";
import {
  fetchChatConversations,
  fetchChatEvents,
  sendChatEncrypted,
} from "./chat-client.js";
import {
  chatPin,
  createChatSession,
  ensureSigningKeys,
  ensureConversationKeys,
  decryptBatch,
  decryptOne,
  encryptForSend,
  messageText,
  eventType,
} from "./chat-crypto.js";

const STATE_FILE = `${os.homedir()}/.openclaw/x-chat-state.json`;

// Chat has no inbox-wide events endpoint, so each poll is 1 list (when needed)
// plus one events fetch per watched 1:1. Stay conservative until field rate
// limits are measured.
const IDLE_MS = 300000;
const ACTIVE_MS = 90000;
const ACTIVE_WINDOW_MS = 180000;
const RATE_LIMIT_FLOOR = 2;

let _sessionPromise = null;

function loadState() {
  const j = loadJsonState(STATE_FILE, {});
  return {
    conversations: j.conversations && typeof j.conversations === "object" ? j.conversations : {},
  };
}

function saveState(state) {
  saveJsonState(STATE_FILE, { conversations: state.conversations });
}

// Prefer sequence_id: the Chat API's ordering field. message_id is not
// guaranteed to be a snowflake, so using it as lastSeen would skip or
// replay under lexical compare.
function eventIdOf(item, decrypted) {
  return String(
    item?.sequence_id ??
      item?.sequenceId ??
      decrypted?.sequenceId ??
      decrypted?.sequence_id ??
      decrypted?.id ??
      item?.id ??
      ""
  );
}

function createdAtOf(item, decrypted) {
  const msec = decrypted?.createdAtMsec ?? decrypted?.created_at_msec ?? item?.created_at_msec ?? item?.createdAtMsec;
  if (msec) {
    const n = Number(msec);
    if (Number.isFinite(n)) return new Date(n).toISOString();
  }
  return decrypted?.createdAt ?? item?.created_at ?? undefined;
}

function toDispatchEvent(item, decrypted, conversationId) {
  const sender = String(decrypted?.senderId ?? decrypted?.sender_id ?? item?.sender_id ?? item?.senderId ?? "");
  const peer = peerFromConversation(conversationId, "") || sender;
  return {
    id: eventIdOf(item, decrypted),
    sender_id: sender,
    text: messageText(decrypted) ?? "",
    created_at: createdAtOf(item, decrypted),
    dm_conversation_id: conversationId,
    event_type: "MessageCreate",
    transport: "chat",
    peer,
  };
}

function collectEncoded(page) {
  const raw = page?.data?.data ?? page?.data ?? [];
  const list = Array.isArray(raw) ? raw : [];
  const meta = page?.data?.meta ?? page?.meta ?? {};
  const keyEvents = meta.conversation_key_events ?? meta.conversationKeyEvents ?? [];
  const encoded = [
    ...keyEvents,
    ...list.map((e) => e.encoded_event ?? e.encodedEvent).filter(Boolean),
  ];
  return { list, meta, encoded };
}

export async function getChatSession(botUserId, log) {
  if (!_sessionPromise) {
    _sessionPromise = createChatSession({ botUserId, log }).catch((err) => {
      _sessionPromise = null;
      throw err;
    });
  }
  return _sessionPromise;
}

export async function sendChatText(recipientId, text, { botUserId, log = console } = {}) {
  const session = await getChatSession(botUserId, log);
  const sliced = String(text ?? "").slice(0, MAX_DM_CHARS);
  if (botUserId) await ensureConversationKeys(session, recipientId, botUserId, { log });
  const body = encryptForSend(session, {
    conversationId: canonicalConversationId(recipientId),
    text: sliced,
  });
  const res = await sendChatEncrypted(recipientId, body);
  return { messageId: res?.data?.data?.id ?? res?.data?.data?.message_id ?? body.message_id };
}

function watchList(account, botId, inboxIds) {
  const policy = account.dmPolicy ?? "allowlist";
  const allow = (account.allowFrom ?? []).map(String);
  if (policy === "allowlist") return allow;
  // pairing / open: watch 1:1 inbox peers so unknown senders can pair.
  const fromInbox = inboxIds
    .map((id) => peerFromConversation(id, botId))
    .filter((id) => id && id !== botId);
  return [...new Set([...allow, ...fromInbox])];
}

export async function startChatAccount(ctx, { account, botId }) {
  const log = ctx?.log ?? console;
  if (!chatPin()) {
    log.error?.(
      "x-dm: transport=chat but X_CHAT_PIN is unset in ~/.openclaw/x-dm-keys.env. " +
        "Classic inbound will also be dark on a PIN-enrolled account. " +
        "Set the PIN (after tools/x-chat-register.mjs) or switch transport back to classic. Staying dormant."
    );
    await awaitAbort(ctx?.abortSignal);
    return;
  }

  let session;
  try {
    session = await getChatSession(botId, log);
  } catch (err) {
    log.error?.(`x-dm: chat session failed — ${err.message}. Staying dormant.`);
    await awaitAbort(ctx?.abortSignal);
    return;
  }

  const state = loadState();
  log.info?.(`x-dm: startAccount — X Chat poller (conversations=${Object.keys(state.conversations).length})`);

  let lastInboundAt = 0;
  let stopped = false;
  let rateLimitResumeAt = 0;

  const noteRateLimit = (remaining, limit, reset) => {
    const remainingNum = Number(remaining);
    if (Number.isFinite(remainingNum) && remainingNum <= RATE_LIMIT_FLOOR) {
      const resetMs = Number(reset) * 1000;
      const until =
        Number.isFinite(resetMs) && resetMs > Date.now() ? resetMs : Date.now() + IDLE_MS;
      rateLimitResumeAt = until;
      log.warn?.(
        `x-dm: chat rate limit nearly exhausted (${remaining}/${limit}) — pausing ${Math.ceil(
          (until - Date.now()) / 1000
        )}s`
      );
    }
  };

  const pollConversation = async (peerId) => {
    // First page is treated as newest (same assumption as classic dm_events).
    // We re-fetch it each poll and advance lastSeen by sequence_id rather than
    // walking next_token, which on X APIs is typically older history.
    const page = await fetchChatEvents(peerId, { maxResults: 100 });
    noteRateLimit(page.remaining, page.limit, page.reset);
    const { list, encoded } = collectEncoded(page);
    const senders = list.map((e) => e.sender_id ?? e.senderId).filter(Boolean);
    await ensureSigningKeys(session, senders, { log });

    if (encoded.length) decryptBatch(session, encoded);

    const convKey = String(peerId);
    const prev = state.conversations[convKey] ?? {};
    let lastSeen = typeof prev.lastSeenEventId === "string" ? prev.lastSeenEventId : null;

    const decryptedMsgs = [];
    for (const item of list) {
      const eventB64 = item.encoded_event ?? item.encodedEvent;
      if (!eventB64) continue;
      let decrypted;
      try {
        decrypted = decryptOne(session, eventB64);
      } catch (err) {
        log.warn?.(`x-dm: chat decrypt failed (${peerId}): ${err.message}`);
        continue;
      }
      if (eventType(decrypted) === "keychange") {
        decryptBatch(session, [eventB64]);
        continue;
      }
      if (eventType(decrypted) !== "message") continue;
      decryptedMsgs.push({ item, decrypted, eventB64 });
    }

    if (lastSeen === null) {
      const newest = newestId(decryptedMsgs, ({ item, decrypted }) => eventIdOf(item, decrypted));
      if (newest) {
        lastSeen = newest;
        state.conversations[convKey] = { lastSeenEventId: lastSeen };
        saveState(state);
        log.info?.(`x-dm: chat seeded ${convKey} lastSeen=${lastSeen} (backlog ignored)`);
      }
      return false;
    }

    const fresh = decryptedMsgs
      .filter(({ item, decrypted }) => idGreater(eventIdOf(item, decrypted), lastSeen))
      .sort((a, b) => (idGreater(eventIdOf(a.item, a.decrypted), eventIdOf(b.item, b.decrypted)) ? 1 : -1));

    let gotInbound = false;
    let newMarker = lastSeen;
    for (const { item, decrypted, eventB64 } of fresh) {
      const id = eventIdOf(item, decrypted);
      if (idGreater(id, newMarker)) newMarker = id;
      const sender = String(decrypted.senderId ?? decrypted.sender_id ?? item.sender_id ?? "");
      if (botId && sender === botId) continue;
      const ev = toDispatchEvent(item, decrypted, canonicalConversationId(peerId));
      if (!ev.text) continue;
      gotInbound = true;
      log.info?.(`x-dm: chat inbound from ${sender}: ${ev.text.slice(0, 40)}`);
      try {
        await dispatchInbound(ctx, account, ev, async (to, text) => {
          const body = encryptForSend(session, {
            conversationId: ev.dm_conversation_id,
            text: String(text ?? "").slice(0, MAX_DM_CHARS),
            replyToEvent: eventB64,
          });
          await sendChatEncrypted(to, body);
        });
      } catch (err) {
        log.warn?.(`x-dm: chat dispatch error (message dropped): ${err.message}`);
      }
    }

    if (newMarker !== lastSeen) {
      state.conversations[convKey] = { lastSeenEventId: newMarker };
      saveState(state);
    }
    return gotInbound;
  };

  const poll = async () => {
    try {
      let inboxIds = [];
      const policy = account.dmPolicy ?? "allowlist";
      if (policy !== "allowlist") {
        try {
          const listed = await fetchChatConversations({ maxResults: 100 });
          noteRateLimit(listed.remaining, listed.limit, listed.reset);
          const convs = listed.data?.data ?? [];
          inboxIds = convs
            .map((c) => c.id)
            .filter((id) => id && !isGroupConversationId(id));
        } catch (err) {
          log.warn?.(`x-dm: chat inbox list failed: ${err.message}`);
        }
      }

      const peers = watchList(account, botId, inboxIds);
      if (!peers.length) {
        log.info?.("x-dm: chat poll — no 1:1 peers to watch (empty allowFrom / inbox)");
        return;
      }

      let gotInbound = false;
      for (const peer of peers) {
        try {
          if (await pollConversation(peer)) gotInbound = true;
        } catch (err) {
          log.warn?.(`x-dm: chat poll ${peer}: ${err.message}`);
        }
      }
      if (gotInbound) lastInboundAt = Date.now();
      const active = Date.now() - lastInboundAt < ACTIVE_WINDOW_MS;
      log.info?.(`x-dm: chat poll (${active ? "active" : "idle"}) — ${peers.length} peer(s)`);
    } catch (err) {
      log.warn?.(`x-dm chat poll error: ${err.message}`);
    }
  };

  const loop = async () => {
    while (!stopped) {
      await poll();
      const active = Date.now() - lastInboundAt < ACTIVE_WINDOW_MS;
      const wait = active ? ACTIVE_MS : IDLE_MS;
      const untilReset = rateLimitResumeAt - Date.now();
      await sleep(Math.max(wait, untilReset > 0 ? untilReset : 0), ctx?.abortSignal);
    }
  };

  const runner = loop();
  await new Promise((resolve) => {
    const sig = ctx?.abortSignal;
    if (sig?.aborted) {
      stopped = true;
      return resolve();
    }
    sig?.addEventListener?.(
      "abort",
      () => {
        stopped = true;
        resolve();
      },
      { once: true }
    );
  });
  await runner;
}

// Used by tests — not part of the runtime contract.
export const _internals = { watchList, collectEncoded, toDispatchEvent, eventIdOf };
