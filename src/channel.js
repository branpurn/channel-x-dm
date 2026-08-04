import {
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import fs from "node:fs";
import os from "node:os";
import { sendDm, fetchDmEvents, isConfigured as credsReady, botUserId, missingKeys } from "./client.js";

const CHANNEL_ID = "x-dm";
const STATE_FILE = `${os.homedir()}/.openclaw/x-dm-state.json`;

// Poll cadence is bounded by the X API budget, not by how responsive we'd like
// to be. Observed on GET /2/dm_events: 15 requests per 15-minute window (the
// x-rate-limit-* headers decrement by 1 per poll and reset on the quarter hour).
// That is one request per 60s sustained. The old 30s active cadence was exactly
// 2x over budget, so a live conversation — the moment responsiveness matters —
// burned the window and then ate 429s until it rolled over.
const IDLE_MS = 300000;          // 5 min when quiet (3 req/window)
const ACTIVE_MS = 90000;         // 90 s during a live conversation (10 req/window)
const ACTIVE_WINDOW_MS = 180000; // stay "active" 3 min after last inbound
// Below this many remaining requests, stop polling until the window resets
// rather than spending the last of the budget and failing closed.
const RATE_LIMIT_FLOOR = 2;

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
        // Prefer the event's own created_at: polling can lag a send by a full
        // idle interval, and stamping at ingest time skewed every message by up
        // to 5 minutes. Falls back to now if X omits or malforms the field.
        timestamp: Date.parse(msg.created_at ?? "") || Date.now(),
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
              await sendDm(from, text); // sendDm enforces the length ceiling
              log.info?.(`x-dm: replied to ${from}`);
              return { visibleReplySent: true };
            },
          },
        };
      },
    },
  });
}

export const xDmBase = {
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
    // Doctor behavior descriptor. Declares that this DM-only channel
    // (capabilities.chatTypes: ["direct"]) has no group surface, so doctor
    // should not synthesize a group allowlist for it.
    //
    // NOTE: inert on OpenClaw 2026.7.1-2 — verified empirically, not assumed.
    // getDoctorChannelCapabilities() resolves via getManifestDoctorCapabilities
    // (filters origin:"bundled") and then normalizeAnyChannelId (plugin
    // registry), neither of which sees an externally-installed channel while
    // maybeRepairGroupAllowFromFallback runs. It therefore returns
    // DEFAULT_DOCTOR_CHANNEL_CAPABILITIES (fallback: true) and copies
    // channels.x-dm.allowFrom into groupAllowFrom on every `doctor --fix`.
    // Confirmed to hit @openclaw/signal identically, so it is an upstream gap,
    // not specific to this plugin. Deleting the key cannot win: the repair
    // skips only on a NON-EMPTY value, so an absent key re-arms it every run.
    // The written key is harmless here — nothing in src/ reads groupAllowFrom —
    // so we let it stand rather than churn. Kept because it is correct and will
    // take effect once the capability lookup reaches external plugins.
    doctor: {
      groupAllowFromFallbackToAllowFrom: false,
      warnOnEmptyGroupSenderAllowlist: false,
    },
    setup: { applyAccountConfig: (cfg) => cfg },
    config: {
      listAccountIds: listXAccountIds,
      resolveAccount: resolveXAccount,
      inspectAccount: (cfg) => {
        const s = getChannelConfig(cfg);
        return { enabled: s.enabled !== false, configured: credsReady() };
      },
      isConfigured: () => credsReady(),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: "X DM",
        configured: credsReady(),
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

        const awaitAbort = () =>
          new Promise((resolve) => {
            const sig = ctx?.abortSignal;
            if (sig?.aborted) return resolve();
            sig?.addEventListener?.("abort", () => resolve(), { once: true });
          });

        // Not configured yet: stay alive but DORMANT — no polling, no API calls,
        // no cost, no crash. Lets the plugin be installed (e.g. from ClawHub)
        // before setup.sh runs. Provide credentials + restart to activate.
        if (!credsReady()) {
          log.warn?.(
            `x-dm: not configured — missing ${missingKeys().join(", ")} in ~/.openclaw/x-dm-keys.env. ` +
              "Run setup.sh (or create the env file), then restart the gateway. Staying dormant."
          );
          await awaitAbort();
          return;
        }

        const account = resolveXAccount(ctx.cfg, ctx.accountId);
        const botId = botUserId();

        // Without X_USER_ID we cannot tell our own sends apart from inbound, so
        // every reply we make is re-ingested as a new message and answered again
        // — an unbounded loop against a paid API. This used to warn and carry on;
        // staying dormant is the only safe response, and it matches the
        // not-configured path above (fix credentials, restart, done).
        if (!botId) {
          log.error?.(
            "x-dm: X_USER_ID is not set in ~/.openclaw/x-dm-keys.env — without it the bot cannot " +
              "recognize its own messages and would reply to itself in a loop. Staying dormant. " +
              "Add X_USER_ID (the bot's numeric id) and restart the gateway."
          );
          await awaitAbort();
          return;
        }

        let lastSeenEventId = loadLastSeen();
        log.info?.(`x-dm: startAccount — adaptive poller (lastSeen=${lastSeenEventId ?? "none"})`);

        let lastInboundAt = 0;
        let stopped = false;
        // Set when the API budget is spent; poll() hands the loop a deadline to
        // sleep to instead of its normal cadence.
        let rateLimitResumeAt = 0;

        const newestId = (arr) =>
          arr.reduce((max, e) => (max === null || idGreater(e.id, max) ? e.id : max), null);

        const poll = async () => {
          try {
            const { data, limit, remaining, reset } = await fetchDmEvents();

            // Park until the window rolls over if we're down to the last of the
            // budget. Falls back to one idle interval when the reset header is
            // missing or nonsensical.
            const remainingNum = Number(remaining);
            if (Number.isFinite(remainingNum) && remainingNum <= RATE_LIMIT_FLOOR) {
              const resetMs = Number(reset) * 1000;
              const until =
                Number.isFinite(resetMs) && resetMs > Date.now() ? resetMs : Date.now() + IDLE_MS;
              rateLimitResumeAt = until;
              log.warn?.(
                `x-dm: rate limit nearly exhausted (${remaining}/${limit}) — pausing ${Math.ceil(
                  (until - Date.now()) / 1000
                )}s until window reset`
              );
            }

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
              if (botId && String(e.sender_id) === botId) continue; // skip own sends
              gotInbound = true;
              log.info?.(`x-dm: inbound from ${e.sender_id}: ${String(e.text ?? "").slice(0, 40)}`);
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

        // Interruptible sleep. The abort listener MUST be removed on the normal
        // timeout path: { once: true } only detaches after the event fires, and
        // abort doesn't fire during normal operation — so the previous version
        // leaked one listener per poll onto a signal that lives as long as the
        // process (~120/hour while active) until Node warned about it.
        const sleep = (ms) =>
          new Promise((resolve) => {
            const sig = ctx?.abortSignal;
            let timer;
            const onAbort = () => {
              clearTimeout(timer);
              resolve();
            };
            timer = setTimeout(() => {
              sig?.removeEventListener?.("abort", onAbort);
              resolve();
            }, ms);
            sig?.addEventListener?.("abort", onAbort, { once: true });
          });

        const loop = async () => {
          while (!stopped) {
            await poll();
            const active = Date.now() - lastInboundAt < ACTIVE_WINDOW_MS;
            const wait = active ? ACTIVE_MS : IDLE_MS;
            // A rate-limit pause outranks the normal cadence.
            const untilReset = rateLimitResumeAt - Date.now();
            await sleep(Math.max(wait, untilReset > 0 ? untilReset : 0));
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
};

export const xDmPlugin = createChatChannelPlugin({
  base: xDmBase,
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
