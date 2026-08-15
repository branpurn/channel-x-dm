#!/usr/bin/env node
// Inbound read check for the X Chat transport.
// Lists recent encoded events for each allowlisted peer. Decryption requires
// a registered identity + X_CHAT_PIN (same as the runtime).
import { botUserId, isConfigured } from "../src/client.js";
import { fetchChatEvents } from "../src/chat-client.js";
import { chatPin, createChatSession, decryptOne, messageText, eventType } from "../src/chat-crypto.js";

if (!isConfigured()) {
  console.error("Missing X OAuth keys in ~/.openclaw/x-dm-keys.env");
  process.exit(1);
}
if (!chatPin()) {
  console.error("X_CHAT_PIN is unset — cannot decrypt Chat events.");
  process.exit(1);
}

const botId = botUserId();
const peers = process.argv.slice(2);
if (!peers.length) {
  console.error("Usage: node tools/x-chat-read.mjs <peerUserId> [peerUserId…]");
  process.exit(1);
}

const session = await createChatSession({ botUserId: botId, log: console });
let inbound = false;
for (const peer of peers) {
  const page = await fetchChatEvents(peer, { maxResults: 20 });
  const raw = page.data?.data ?? [];
  console.log(`conversation ${peer}: HTTP events=${raw.length} rl ${page.remaining}/${page.limit}`);
  for (const item of raw) {
    const b64 = item.encoded_event ?? item.encodedEvent;
    if (!b64) continue;
    try {
      const ev = decryptOne(session, b64);
      if (eventType(ev) !== "message") continue;
      const sender = String(ev.senderId ?? ev.sender_id ?? item.sender_id ?? "");
      const text = messageText(ev) ?? "";
      const dir = sender === botId ? "OUT (bot)" : "IN  (received)";
      if (sender !== botId) inbound = true;
      console.log(`  [${dir}] ${sender}: ${text.slice(0, 60)}`);
    } catch (err) {
      console.log(`  [decrypt-failed] ${err.message}`);
    }
  }
}
console.log();
console.log(
  inbound
    ? ">>> Inbound visible — Chat transport can read these."
    : ">>> No inbound — empty thread, decrypt failure, or peer has not enrolled."
);
