// Lightweight setup entry loaded by `openclaw onboard` when x-dm needs
// setup/onboarding surfaces (declared via openclaw.setupEntry in package.json).
//
// NOTE: defineSetupPluginEntry's exact argument shape is the one thing not
// visible in the .d.ts we pulled. This mirrors the bundled
// defineBundledChannelSetupEntry({ plugin: {...} }) pattern; if `openclaw onboard`
// rejects it, see the grep in the chat to confirm the real signature.
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-entry-contract";
import { xDmSetupPlugin } from "./src/channel.setup.js";

export default defineSetupPluginEntry(xDmSetupPlugin);
