import {
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { isConfigured as credsReady, botUserId, missingKeys } from "./client.js";
import { CHANNEL_ID, rememberCfg, resolveTransport } from "./transport.js";
import { normalizeXId, looksLikeXId } from "./ids.js";
import { awaitAbort } from "./poll-utils.js";
import { startClassicAccount, sendClassicText } from "./classic-transport.js";
import { startChatAccount, sendChatText } from "./chat-transport.js";

function getChannelConfig(cfg) {
  return cfg?.channels?.[CHANNEL_ID] ?? {};
}
function resolveXAccount(cfg, accountId) {
  const section = getChannelConfig(cfg);
  return {
    accountId: accountId ?? "default",
    enabled: section.enabled !== false,
    allowFrom: section.allowFrom ?? [],
    dmPolicy: section.dmPolicy ?? "allowlist",
    transport: resolveTransport(cfg),
  };
}
function listXAccountIds() {
  return ["default"];
}

async function sendForTransport(to, text, { cfg, botId, log } = {}) {
  const transport = resolveTransport(cfg);
  if (transport === "chat") {
    return sendChatText(to, text, { botUserId: botId ?? botUserId(), log });
  }
  return sendClassicText(to, text);
}

export const xDmBase = {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "X DM",
      selectionLabel: "X DM",
      detailLabel: "X Direct Messages",
      docsPath: "/channels/x-dm",
      blurb: "Send and receive X Direct Messages via the X API (classic DM or X Chat).",
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
        return {
          enabled: s.enabled !== false,
          configured: credsReady(),
          transport: resolveTransport(cfg),
        };
      },
      isConfigured: () => credsReady(),
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.transport === "chat" ? "X Chat" : "X DM",
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
        rememberCfg(ctx.cfg);

        // Not configured yet: stay alive but DORMANT — no polling, no API calls,
        // no cost, no crash. Lets the plugin be installed (e.g. from ClawHub)
        // before setup.sh runs. Provide credentials + restart to activate.
        if (!credsReady()) {
          log.warn?.(
            `x-dm: not configured — missing ${missingKeys().join(", ")} in ~/.openclaw/x-dm-keys.env. ` +
              "Run setup.sh (or create the env file), then restart the gateway. Staying dormant."
          );
          await awaitAbort(ctx?.abortSignal);
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
          await awaitAbort(ctx?.abortSignal);
          return;
        }

        const transport = resolveTransport(ctx.cfg);
        log.info?.(`x-dm: transport=${transport} (default remains classic until Chat is validated)`);
        if (transport === "chat") {
          return startChatAccount(ctx, { account, botId });
        }
        return startClassicAccount(ctx, { account, botId });
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
        const r = await sendForTransport(normalizeXId(params.to), params.text, {
          cfg: params.cfg,
          botId: botUserId(),
        });
        return { messageId: r?.data?.dm_event_id ?? r?.messageId };
      },
    },
  },
});
