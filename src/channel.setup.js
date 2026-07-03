// Native onboarding wizard for the x-dm channel (drives `openclaw onboard`).
//
// Persistence split, matching what the runtime reads:
//   • the 4 OAuth keys + X_USER_ID  -> ~/.openclaw/x-dm-keys.env  (client.js reads this)
//   • enabled / dmPolicy / allowFrom -> channels.x-dm.*           (channel.js reads this)
//
// Each credential/textInput writes ITSELF to the env file via applySet, so we
// don't depend on the framework threading values into `credentialValues` (the
// one wizard behavior not visible in the type). The poller/runtime is untouched.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { xDmBase } from "./channel.js";
import { readXDmEnv, mergeXDmEnv, isXDmConfigured } from "./configured-state.js";

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
    title: "X DM (unencrypted) — setup",
    lines: [
      "Uses the paid X API (OAuth 1.0a). The bot account must NEVER have set an X Chat PIN, or inbound goes E2E-dark.",
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
  ],
  allowFrom: {
    message: "Which numeric X user IDs may DM the bot? (comma-separated)",
    placeholder: "1234567890, 9876543210",
    invalidWithoutCredentialNote: "",
    parseId: (raw) => {
      const id = /^\d+$/.test(String(raw).trim()) ? String(raw).trim() : null;
      dbg(`allowFrom.parseId(${JSON.stringify(raw)}) -> ${id}`);
      return id;
    },
    resolveEntries: async ({ entries }) => {
      dbg(`allowFrom.resolveEntries entries=${JSON.stringify(entries)}`);
      const mapped = entries.map((e) => {
        const ok = /^\d+$/.test(String(e).trim());
        return { input: e, resolved: ok, id: ok ? String(e).trim() : null };
      });
      const ids = mapped.filter((m) => m.resolved).map((m) => m.id);
      if (ids.length) _pendingAllowFrom = ids;
      return mapped;
    },
    apply: ({ cfg, accountId, allowFrom }) => {
      dbg(`allowFrom.apply accountId=${accountId} allowFrom=${JSON.stringify(allowFrom)}`);
      if (Array.isArray(allowFrom) && allowFrom.length) _pendingAllowFrom = allowFrom;
      return patchChannel(cfg, { allowFrom });
    },
  },
  finalize: async ({ cfg }) => {
    dbg(`finalize pendingAllowFrom=${JSON.stringify(_pendingAllowFrom)}`);
    return {
      cfg: patchChannel(cfg, {
        enabled: true,
        dmPolicy: "allowlist",
        ...(_pendingAllowFrom?.length ? { allowFrom: _pendingAllowFrom } : {}),
      }),
    };
  },
  completionNote: {
    title: "x-dm configured",
    lines: [
      "Credentials saved to ~/.openclaw/x-dm-keys.env; channel config written.",
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
