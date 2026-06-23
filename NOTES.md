# NOTES — OpenClaw channel-plugin SDK, reverse-engineered

The official channel-plugin docs give fragments; the real contract lives in OpenClaw's
minified `dist/` bundles. Learned building `x-dm` against `openclaw 2026.6.9`. This is
about *method* — how to re-derive when things change — not a frozen answer.

## Discovery & placement
- Discovered from `~/.openclaw/extensions/<id>/index.js` (global). **Not** `~/.openclaw/plugins/`.
- Needs `openclaw.plugin.json` in root. Deps `npm install`ed in the plugin dir (gateway won't).
- Non-bundled plugins disabled by default: `plugins.entries.<id>.enabled true`.

## Manifest must declare the channel as an ARRAY
The registry scans a `channels` array, not a singular `channel` object:
`"channels": ["x-dm"]` + `"channelConfigs": { "x-dm": { "schema": {...} } }`.
Without the array the plugin loads but `channelIds` stays empty.

## Registration gate (the slow one)
`dist/registry-*.js` rejects with `missing required config helpers` unless `base.config`
has BOTH `listAccountIds` and `resolveAccount` as functions. Single-account:
`listAccountIds: () => ["default"]`.
**Lesson:** `grep -rn "<error string>" dist/` finds the validation and names the fields.

## Plugin object shape (mirror the bundled `sms` channel)
`createChatChannelPlugin({ base, security, outbound })`. `base` carries:
`id, meta, capabilities, reload, setup{applyAccountConfig}, config{listAccountIds,
resolveAccount, inspectAccount, isConfigured, describeAccount},
messaging{targetPrefixes, normalizeTarget, targetResolver{looksLikeId, hint}},
gateway{startAccount}`.
- `looksLikeId` lives in `base.messaging.targetResolver`, NOT base top level.
- `resolveTarget` lives in `outbound`, returns `{ ok, to }`.

## Lifecycle: gateway.startAccount, long-lived
No `lifecycle.start`. The gateway calls `base.gateway.startAccount(ctx)` per account, and
it must stay alive until `ctx.abortSignal` fires, or the gateway logs
`channel exited without an error` and auto-restarts in a backoff loop. Keep it awaiting
the abort signal.

## Inbound dispatch (the real method — what `dispatchInbound` should have been)
`ctx.channelRuntime.inbound` exposes: `buildContext, run, runPreparedReply, dispatchReply`.
The dispatch call is `await ctx.channelRuntime.inbound.run({ channel, accountId, raw,
adapter })` where `adapter` has:
- `ingest(raw)` → `{ id, timestamp, rawText, textForAgent, textForCommands, raw }`
- `resolveTurn(input)` → builds `ctxPayload` via `ctx.channelRuntime.inbound.buildContext({...})`
  and returns a turn descriptor including `recordInboundSession`
  (`ctx.channelRuntime.session.recordInboundSession`),
  `dispatchReplyWithBufferedBlockDispatcher`
  (`ctx.channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher`),
  and `delivery.deliver(payload)` — where `payload.text` is the agent's reply.
  For x-dm, `deliver` calls `sendDm(sender_id, payload.text)`.

Route comes from `ctx.channelRuntime.routing.resolveAgentRoute({ cfg, channel, accountId,
peer:{kind:"direct", id} })`. Mirror SMS's `channel-plugin-api.js` ~line 658.

## ctx.channelRuntime surface (dump it if unsure)
`text, reply, routing, pairing, media, activity, session, mentions, reactions, groups,
debounce, commands, outbound, inbound, threadBindings, runtimeContexts`.
Instrument with `log.info(Object.keys(ctx.channelRuntime.inbound))` to confirm method names.

## Loop guard
Skip events whose `sender_id` is the bot's own id, or the agent replies to its own
outbound DM forever.

## Debug workflow
1. `openclaw plugins inspect x-dm --runtime --json` → status / channelIds / error.
2. `grep -rn "<error>" ~/.npm-global/lib/node_modules/openclaw/dist/`.
3. Read the bundled `sms` channel as the template, not the docs.
4. Log-instrument `startAccount` + the poller to see it breathe.
