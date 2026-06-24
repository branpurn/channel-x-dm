import {
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import fs from "node:fs";
import os from "node:os";
import { sendDm, fetchDmEvents } from "./client.js";

const CHANNEL_ID = "x-dm";
// IMPORTANT: set this to YOUR bot account's numeric user ID so the poller
// skips the bot's own sent messages (prevents reply loops). setup.sh patches it.
const BOT_USER_ID = "0000000000000000000";
const STATE_FILE = `${os.homedir()}/.openclaw/x-dm-state.json`;

const IDLE_MS = 300000;          // 5 min when quiet
const ACTIVE_MS = 30000;         // 30 s during a live conversation
const ACTIVE_WINDOW_MS = 180000; // stay "active" 3 min after last inbound

// --- persistent dedup marker (survives restarts/reboots) ---
// Semantics: at-least-once on the read side, drop-on-error on dispatch.
// The marker advances once per poll batch (and per event, even if dispatch
// throws). Consequence: a transient dispatch error (e.g. model hiccup) drops
// that one message rather than retrying it. This is deliberate — retrying a
// permanently-failing ("poison") message would loop forever every poll. For a
// personal agent, a rare dropped reply you can just re-send beats both a retry
// loop and reboot-replay spam.
function loadLastSeen() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return typeof j.lastSeenEventId === "string" ? j.lastSeenEventId : null;
  } catch {
    return null;
  }
}
function saveLastSeen(id) {
  if (!id) return;
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ lastSeenEventId: id }), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE); // atomic on POSIX
  } catch {
    /* best-effort */
  }
}
// Numeric (BigInt) comparison of snowflake-style string IDs. true if a > b.
// Avoids lexical-vs-numeric mismatch if X ever changes ID digit length.
function idGreater(a, b) {
  try {
    return BigInt(a) > BigInt(b);
  } catch {
    return String(a) > String(b);
  }
}

function getChannelConfig(cfg) {
  return cfg?.channels?.[CHANNEL_ID] ?? {};
}
function normalizeXId(raw) {
  return String(raw ?? "").trim().replace(/^x-dm:/i, "");
}
function looksLikeXId(raw) {
  return /^\d{1,25}$/.test(normalizeXId(raw));
}
function resolveXAccount(cfg, accountId) {
  const section = getChannelConfig(cfg);
  return {
    accountId: accountId ?? "default",
    enabled: section.enabled !== false,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmPolicy ?? "allowlist",
  };
}
function listXAccountIds() {
  return ["default"];
}

async function dispatchInbound(ctx, account, e) {
  const log = ctx?.log ?? console;
  const from = String(e.sender_id);
  const rt = ctx.channelRuntime;

  const route = rt.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId: account.accountId,
    peer: { kind: "direct", id: from },
  });
  const sessionKey = route.sessionKey;

  await rt.inbound.run({
    channel: CHANNEL_ID,
    accountId: account.accountId,
    raw: e,
    adapter: {
      ingest: (msg) => ({
        id: msg.id,
        timestamp: Date.now(),
        rawText: msg.text,
        textForAgent: msg.text,
        textForCommands: msg.text,
        raw: msg,
      }),
      resolveTurn: async (input) => {
        const ctxPayload = rt.inbound.buildContext({
          channel: CHANNEL_ID,
          accountId: account.accountId,
          timestamp: input.timestamp,
          from: `x-dm:${from}`,
          sender: { id: from, name: from },
          conversation: { kind: "direct", id: from, label: from },
          route: {
            agentId: route.agentId,
            accountId: account.accountId,
            routeSessionKey: sessionKey,
            dispatchSessionKey: sessionKey,
          },
          reply: { to: `x-dm:${from}` },
          message: {
            rawBody: input.rawText,
            commandBody: input.textForCommands,
            bodyForAgent: input.textForAgent,
          },
          extra: { dm_event_id: e.id },
        });
        const storePath = rt.session.resolveStorePath(ctx.cfg.session?.store, {
          agentId: route.agentId,
        });
        return {
          cfg: ctx.cfg,
          channel: CHANNEL_ID,
          accountId: account.accountId,
          agentId: route.agentId,
          routeSessionKey: sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession: rt.session.recordInboundSession,
          dispatchReplyWithBufferedBlockDispatcher:
            rt.reply.dispatchReplyWithBufferedBlockDispatcher,
          delivery: {
            durable: () => ({ to: from }),
            deliver: async (payload) => {
              const text = payload?.text;
              if (!text) return { visibleReplySent: false };
              await sendDm(from, String(text).slice(0, 9000));
              log.info?.(`x-dm: replied to ${from}`);
              return { visibleReplySent: true };
            },
          },
        };
      },
    },
  });
}

export const xDmPlugin = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "X DM",
      selectionLabel: "X DM",
      detailLabel: "X Direct Messages",
      docsPath: "/channels/x-dm",
      blurb: "Send and receive X Direct Messages via the X API.",
      order: 90,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: false, threads: false, reactions: false,
      edit: false, unsend: false, reply: false,
      effects: false, blockStreaming: false,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    setup: { applyAccountConfig: (cfg) => cfg },
    config: {
      listAccountIds: listXAccountIds,
      resolveAccount: resolveXAccount,
      inspectAccount: (cfg) => {
        const s = getChannelConfig(cfg);
        return { enabled: s.enabled !== false };
      },
      isConfigured: () => true,
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: "X DM",
        configured: true,
        enabled: account.enabled,
      }),
    },
    messaging: {
      targetPrefixes: ["x-dm"],
      normalizeTarget: (t) => normalizeXId(t),
      targetResolver: {
        looksLikeId: looksLikeXId,
        hint: "<numeric X user id>",
      },
    },
    gateway: {
      startAccount: async (ctx) => {
        const log = ctx?.log ?? console;
        const account = resolveXAccount(ctx.cfg, ctx.accountId);

        let lastSeenEventId = loadLastSeen();
        log.info?.(`x-dm: startAccount — adaptive poller (lastSeen=${lastSeenEventId ?? "none"})`);

        let lastInboundAt = 0;
        let stopped = false;

        const newestId = (arr) =>
          arr.reduce((max, e) => (max === null || idGreater(e.id, max) ? e.id : max), null);

        const poll = async () => {
          try {
            const { data, limit, remaining } = await fetchDmEvents();
            const all = data?.data ?? [];
            const msgs = all.filter((e) => e.event_type === "MessageCreate");

            // FIRST RUN (no marker): adopt newest, dispatch nothing (ignore backlog).
            if (lastSeenEventId === null) {
              const newest = newestId(msgs);
              if (newest) {
                lastSeenEventId = newest;
                saveLastSeen(lastSeenEventId);
                log.info?.(`x-dm: seeded lastSeen=${lastSeenEventId} (backlog ignored)`);
              }
              log.info?.(`x-dm: poll (seed) — ${all.length} events (rl ${remaining}/${limit})`);
              return;
            }

            // strictly-newer events, oldest-first by numeric value
            const fresh = msgs
              .filter((e) => idGreater(e.id, lastSeenEventId))
              .sort((a, b) => (idGreater(a.id, b.id) ? 1 : -1));

            let gotInbound = false;
            let newMarker = lastSeenEventId;
            for (const e of fresh) {
              // Advance the marker even on dispatch failure (see header comment:
              // drop-on-error, not retry — avoids poison-message loops).
              if (idGreater(e.id, newMarker)) newMarker = e.id;
              if (String(e.sender_id) === BOT_USER_ID) continue; // skip own sends
              gotInbound = true;
              log.info?.(`x-dm: inbound from ${e.sender_id}: ${String(e.text).slice(0, 40)}`);
              try {
                await dispatchInbound(ctx, account, e);
              } catch (err) {
                log.warn?.(`x-dm: dispatch error (message dropped): ${err.message}`);
              }
            }

            if (newMarker !== lastSeenEventId) {
              lastSeenEventId = newMarker;
              saveLastSeen(lastSeenEventId); // one write per batch
            }
            if (gotInbound) lastInboundAt = Date.now();
            const active = Date.now() - lastInboundAt < ACTIVE_WINDOW_MS;
            log.info?.(`x-dm: poll (${active ? "active" : "idle"}) — ${all.length} events (rl ${remaining}/${limit})`);
          } catch (err) {
            log.warn?.(`x-dm poll error: ${err.message}`);
          }
        };

        const loop = async () => {
          while (!stopped) {
            await poll();
            const active = Date.now() - lastInboundAt < ACTIVE_WINDOW_MS;
            const wait = active ? ACTIVE_MS : IDLE_MS;
            await new Promise((r) => {
              const t = setTimeout(r, wait);
              const sig = ctx?.abortSignal;
              sig?.addEventListener?.("abort", () => { clearTimeout(t); r(); }, { once: true });
            });
          }
        };

        const runner = loop();
        await new Promise((resolve) => {
          const sig = ctx?.abortSignal;
          if (sig?.aborted) { stopped = true; return resolve(); }
          sig?.addEventListener?.("abort", () => { stopped = true; resolve(); }, { once: true });
        });
        await runner;
      },
    },
  },

  security: {
    resolveDmPolicy: (account) => account.dmPolicy,
  },

  outbound: {
    deliveryMode: "gateway",
    resolveTarget: ({ to }) => {
      const id = normalizeXId(to ?? "");
      if (id) return { ok: true, to: id };
      return { ok: false, error: new Error("x-dm target must be a numeric X user id.") };
    },
    attachedResults: {
      sendText: async (params) => {
        const r = await sendDm(normalizeXId(params.to), params.text);
        return { messageId: r?.data?.dm_event_id };
      },
    },
  },
});
