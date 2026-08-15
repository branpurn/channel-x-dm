// Transport selector for the x-dm channel.
//
// Two parallel implementations share one channel id, allowlist, and binding:
//   • classic — legacy unencrypted DM API (GET /2/dm_events). Default until
//     the Chat path is validated in the field.
//   • chat    — X Chat API (GET /2/chat/conversations, encrypted via chat-xdk).
//
// Flip DEFAULT_TRANSPORT to "chat" once Chat is the supported default. An
// explicit channels.x-dm.transport or X_DM_TRANSPORT always wins.
import { readXDmEnv } from "./configured-state.js";

export const CHANNEL_ID = "x-dm";
export const TRANSPORTS = Object.freeze(["classic", "chat"]);

// Default stays classic until the Chat path is validated. Changing this one
// constant (and the schema default) is the cutover.
export const DEFAULT_TRANSPORT = "classic";

let _cfgOverride = null;

// startAccount remembers the live cfg so outbound sendText (which may not
// receive cfg) resolves the same transport the poller is running.
export function rememberCfg(cfg) {
  _cfgOverride = cfg ?? null;
}

export function normalizeTransport(raw) {
  const v = String(raw ?? "")
    .trim()
    .toLowerCase();
  return v === "chat" ? "chat" : "classic";
}

export function resolveTransport(cfg = _cfgOverride) {
  const fromCfg = cfg?.channels?.[CHANNEL_ID]?.transport;
  const fromEnv = readXDmEnv().X_DM_TRANSPORT;
  return normalizeTransport(fromCfg || fromEnv || DEFAULT_TRANSPORT);
}

export function isChatTransport(cfg) {
  return resolveTransport(cfg) === "chat";
}
