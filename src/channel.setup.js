// Native onboarding wizard for the x-dm channel (drives `openclaw onboard`).
//
// Persistence split, matching what the runtime reads:
//   • the 4 OAuth keys + X_USER_ID  -> ~/.openclaw/x-dm-keys.env  (client.js reads this)
//   • enabled / transport / dmPolicy / allowFrom -> channels.x-dm.*  (channel.js reads this)
//
// Each credential/textInput writes ITSELF to the env file via applySet, so we
// don't depend on the framework threading values into `credentialValues` (the
// one wizard behavior not visible in the type). The poller/runtime is untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPromptParsedAllowFromForAccount,
  splitSetupEntries,
  mergeAllowFromEntries,
} from "openclaw/plugin-sdk/setup";
import { xDmBase } from "./channel.js";
import { readXDmEnv, mergeXDmEnv, isXDmConfigured } from "./configured-state.js";
import { DEFAULT_TRANSPORT, normalizeTransport } from "./transport.js";
import { weakPinReason } from "./chat-pin.js";

const CHANNEL = "x-dm";

// The allowFrom step resolved entries but the value never reached config on
// 2026.6.9 (the write path belongs to the dmPolicy-step machinery, which this
// wizard doesn't define — finalize owns dmPolicy instead). So we stash whatever
// the framework hands our allowFrom hooks and write it in finalize, whose
// returned cfg is proven to persist. Self-contained, like the credential steps.
let _pendingAllowFrom = null;

// Opt-in trace: X_DM_WIZARD_DEBUG=1 openclaw onboard
// appends one line per hook call to ~/.openclaw/x-dm-wizard-debug.log
function dbg(msg) {
  if (!process.env.X_DM_WIZARD_DEBUG) return;
  try {
    fs.appendFileSync(
      path.join(os.homedir(), ".openclaw", "x-dm-wizard-debug.log"),
      `${new Date().toISOString()} ${msg}\n`
    );
  } catch {
    /* never let tracing break onboarding */
  }
}

function patchChannel(cfg, patch) {
  const channels = cfg.channels ?? {};
  return {
    ...cfg,
    channels: { ...channels, [CHANNEL]: { ...(channels[CHANNEL] ?? {}), ...patch } },
  };
}

// Factory-built allowFrom prompt (public SDK; mirrors bundled Google Chat).
// Hoisted so BOTH the dmPolicy step and finalize can drive it: QuickStart
// onboarding skips the dmPolicy step entirely (SetupChannelsOptions.
// skipDmPolicyPrompt / quickstartDefaults), so finalize must be able to
// collect the allowlist itself or QuickStart users end up with an empty one.
const promptXDmAllowFrom = createPromptParsedAllowFromForAccount({
  defaultAccountId: () => "default",
  message: "Which numeric X user IDs may DM the bot? (comma-separated)",
  placeholder: "1234567890, 9876543210",
  parseEntries: (raw) => {
    const entries = mergeAllowFromEntries(void 0, splitSetupEntries(raw));
    dbg(`allowFrom.parseEntries(${JSON.stringify(raw)}) -> ${JSON.stringify(entries)}`);
    return { entries };
  },
  getExistingAllowFrom: ({ cfg }) => cfg.channels?.[CHANNEL]?.allowFrom ?? [],
  applyAllowFrom: ({ cfg, accountId, allowFrom }) => {
    dbg(`allowFrom.applyAllowFrom accountId=${accountId} allowFrom=${JSON.stringify(allowFrom)}`);
    if (Array.isArray(allowFrom) && allowFrom.length) _pendingAllowFrom = allowFrom;
    return patchChannel(cfg, { allowFrom });
  },
});

// One secret step per OAuth key. inspect() reads the env file so a re-run offers
// "keep existing"; applySet() writes the resolved value straight back to the file.
function cred(inputKey, envVar, label) {
  return {
    inputKey,
    providerHint: "x",
    credentialLabel: label,
    // No preferredEnvVar / env path: creds live in the env FILE, not process.env.
    // allowEnv:false routes every credential through applySet -> the env file.
    // (envPrompt is required by the type but never shown while allowEnv is false.)
    envPrompt: `Use ${envVar} from the environment?`,
    keepPrompt: `Keep the existing ${label}?`,
    inputPrompt: `Paste your ${label}`,
    allowEnv: () => false,
    inspect: () => {
      const v = readXDmEnv()[envVar];
      return { accountConfigured: Boolean(v), hasConfiguredValue: Boolean(v), resolvedValue: v };
    },
    applySet: ({ cfg, resolvedValue }) => {
      if (resolvedValue) mergeXDmEnv({ [envVar]: resolvedValue });
      return cfg;
    },
  };
}

export const xDmSetupWizard = {
  channel: CHANNEL,
  status: {
    configuredLabel: "Configured — X API keys present",
    unconfiguredLabel: "Needs X API keys",
    resolveConfigured: () => isXDmConfigured(),
  },
  introNote: {
    title: "X DM — setup",
    lines: [
      "Two transports share this channel. Default is classic (unencrypted DM API). Chat is opt-in until validated.",
      "classic: the bot account must NEVER have set an X Chat PIN, or inbound goes E2E-dark.",
      "chat: enrolls the bot (public key + Juicebox PIN) via the new X Chat API. That enrollment breaks classic inbound on the same account.",
      "You'll provide 4 OAuth keys + the bot's numeric user id. They're written to ~/.openclaw/x-dm-keys.env (chmod 600).",
    ],
  },
  stepOrder: "credentials-first",
  credentials: [
    cred("apiKey", "X_API_KEY", "X API key (consumer key)"),
    cred("apiSecret", "X_API_SECRET", "X API secret (consumer secret)"),
    cred("accessToken", "X_ACCESS_TOKEN", "X access token"),
    cred("accessSecret", "X_ACCESS_SECRET", "X access token secret"),
  ],
  textInputs: [
    {
      inputKey: "userId",
      message: "Bot's numeric X user ID (X_USER_ID) — used for loop protection",
      placeholder: "1234567890",
      required: true,
      helpTitle: "Finding the bot's numeric user ID",
      helpLines: [
        "DM the bot from your account, open the conversation, and read the URL x.com/i/chat/<idA>-<idB>.",
        "The id that isn't yours is the bot's.",
      ],
      currentValue: () => readXDmEnv().X_USER_ID,
      validate: ({ value }) =>
        /^\d+$/.test(String(value).trim()) ? undefined : "Must be a numeric user ID.",
      applySet: ({ cfg, value }) => {
        if (value) mergeXDmEnv({ X_USER_ID: String(value).trim() });
        return cfg;
      },
    },
    {
      inputKey: "transport",
      message: `Message transport: classic (unencrypted DM API, default) or chat (new X Chat API). Default is ${DEFAULT_TRANSPORT}.`,
      placeholder: DEFAULT_TRANSPORT,
      required: false,
      helpTitle: "classic vs chat",
      helpLines: [
        "classic uses GET /2/dm_events and POST /2/dm_conversations/with/{id}/messages. Keep this until Chat is validated.",
        "chat uses GET /2/chat/conversations and the chat-xdk. Requires X_CHAT_PIN and a one-time public-key registration (tools/x-chat-register.mjs).",
        "Do not run both on the same bot account: Chat enrollment encrypts the inbox and blinds classic inbound.",
      ],
      currentValue: () => readXDmEnv().X_DM_TRANSPORT || DEFAULT_TRANSPORT,
      validate: ({ value }) => {
        if (value == null || String(value).trim() === "") return undefined;
        const v = String(value).trim().toLowerCase();
        return v === "classic" || v === "chat" ? undefined : "Must be classic or chat.";
      },
      applySet: ({ cfg, value }) => {
        if (value == null || String(value).trim() === "") return cfg;
        const transport = normalizeTransport(value);
        mergeXDmEnv({ X_DM_TRANSPORT: transport });
        return patchChannel(cfg, { transport });
      },
    },
    {
      inputKey: "chatPin",
      message: "X Chat PIN (X_CHAT_PIN) — only for transport=chat; leave blank for classic",
      placeholder: "(optional)",
      required: false,
      helpTitle: "X Chat PIN",
      helpLines: [
        "Juicebox recovery PIN for the bot identity. Required to unlock Chat keys.",
        "At least 4 characters; not a repeated character or a sequential digit run (1234 / 4321).",
        "After saving, run: node tools/x-chat-register.mjs --confirm",
      ],
      currentValue: () => readXDmEnv().X_CHAT_PIN,
      validate: ({ value }) => {
        if (value == null || String(value).trim() === "") return undefined;
        const reason = weakPinReason(String(value).trim());
        return reason ? `PIN ${reason}` : undefined;
      },
      applySet: ({ cfg, value }) => {
        if (value) mergeXDmEnv({ X_CHAT_PIN: String(value).trim() });
        return cfg;
      },
    },
    {
      inputKey: "oauth2Token",
      message: "Optional OAuth 2.0 user access token (X_OAUTH2_ACCESS_TOKEN) for Chat — leave blank to use OAuth 1.0a",
      placeholder: "(optional)",
      required: false,
      helpTitle: "OAuth 2.0 user token",
      helpLines: [
        "Official Chat examples use an OAuth 2.0 user-context token with dm.read + dm.write.",
        "If unset, Chat calls use the same OAuth 1.0a user context as classic DMs.",
      ],
      currentValue: () => readXDmEnv().X_OAUTH2_ACCESS_TOKEN,
      applySet: ({ cfg, value }) => {
        if (value) mergeXDmEnv({ X_OAUTH2_ACCESS_TOKEN: String(value).trim() });
        return cfg;
      },
    },
  ],
  // The native DM-policy step. This is where onboarding actually writes
  // allowFrom on 2026.6.9: the dmPolicy machinery owns the policy+allowFrom
  // patch, and promptAllowFrom (built with the public factory, mirroring the
  // bundled Google Chat channel) collects and applies the allowlist. Our
  // previous declarative `allowFrom` section was never driven by this flow
  // (instrumented run: zero hooks fired).
  dmPolicy: {
    label: "X DM",
    channel: CHANNEL,
    policyKey: "channels.x-dm.dmPolicy",
    allowFromKey: "channels.x-dm.allowFrom",
    getCurrent: (cfg) => cfg.channels?.[CHANNEL]?.dmPolicy ?? "allowlist",
    setPolicy: (cfg, policy) => {
      dbg(`dmPolicy.setPolicy policy=${policy}`);
      return patchChannel(cfg, { dmPolicy: policy });
    },
    promptAllowFrom: promptXDmAllowFrom,
  },
  finalize: async ({ cfg, accountId, prompter, forceAllowFrom }) => {
    dbg(`finalize forceAllowFrom=${forceAllowFrom} pendingAllowFrom=${JSON.stringify(_pendingAllowFrom)}`);
    let next = patchChannel(cfg, {
      enabled: true,
      ...(cfg.channels?.[CHANNEL]?.dmPolicy ? {} : { dmPolicy: "allowlist" }),
      ...(cfg.channels?.[CHANNEL]?.transport ? {} : { transport: DEFAULT_TRANSPORT }),
      ...(_pendingAllowFrom?.length ? { allowFrom: _pendingAllowFrom } : {}),
    });
    // QuickStart (and any flow with skipDmPolicyPrompt) never runs the dmPolicy
    // step, so nothing upstream collects the allowlist. If it's still empty and
    // we have a prompter, collect it here — otherwise dmPolicy=allowlist drops
    // every DM and onboarding ends in a footgun warning.
    const have = next.channels?.[CHANNEL]?.allowFrom;
    const policy = next.channels?.[CHANNEL]?.dmPolicy;
    if (policy === "allowlist" && (!Array.isArray(have) || !have.length) && prompter) {
      try {
        dbg("finalize: allowFrom empty under allowlist — prompting");
        next = await promptXDmAllowFrom({ cfg: next, prompter, accountId });
        dbg(`finalize: post-prompt allowFrom=${JSON.stringify(next.channels?.[CHANNEL]?.allowFrom)}`);
      } catch (e) {
        dbg(`finalize: allowFrom prompt failed/cancelled: ${e?.message ?? e}`);
      }
    }
    return { cfg: next };
  },
  completionNote: {
    title: "x-dm configured",
    lines: [
      "Credentials saved to ~/.openclaw/x-dm-keys.env; channel config written.",
      "Default transport is classic. To try X Chat: set channels.x-dm.transport=chat, install @xdevplatform/chat-xdk + juicebox-sdk, run tools/x-chat-register.mjs --confirm, then restart.",
      "If the channel doesn't come up: openclaw plugins enable x-dm && openclaw gateway restart",
    ],
  },
};

// Setup plugin consumed by defineSetupPluginEntry. Reads id/meta/capabilities/
// config/setup straight from the base LITERAL (not the factory return, whose
// shape isn't visible), so the object is complete regardless of how
// createChatChannelPlugin builds its result. Adds the wizard. Poller untouched.
export const xDmSetupPlugin = {
  id: xDmBase.id,
  meta: xDmBase.meta,
  capabilities: xDmBase.capabilities,
  config: xDmBase.config,
  setup: xDmBase.setup,
  setupWizard: xDmSetupWizard,
};
