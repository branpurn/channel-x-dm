// Onboarding entry for `openclaw onboard`. `openclaw.setupEntry` in package.json
// points here, and OpenClaw reads this default export.
//
// This MUST be a separate module from the one that exports xDmSetupPlugin: the
// SDK's loader resolves the { specifier, exportName } pointer by reading that
// module's exports, and a self-referential specifier (entry + plugin in one file)
// fails with "missing export" because the export isn't visible mid-evaluation.
// So the entry lives here and points at its sibling ./channel.setup.js. Both files
// are part of the plugin source under src/ — nothing loose at the repo root.
//
// defineBundledChannelSetupEntry is the only setup-entry helper the runtime SDK
// actually exports (2026.6.9), the same one the bundled Discord plugin uses.
import { defineBundledChannelSetupEntry } from "openclaw/plugin-sdk/channel-entry-contract";

export default defineBundledChannelSetupEntry({
  importMetaUrl: import.meta.url,
  features: {},
  plugin: { specifier: "./channel.setup.js", exportName: "xDmSetupPlugin" },
});
