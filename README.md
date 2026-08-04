# X DM (Unencrypted) Channel for OpenClaw

Use legacy **unencrypted** X (Twitter) Direct Messages as a bidirectional channel for [OpenClaw](https://docs.openclaw.ai). Talk to your agent over X DMs. Uses the paid X API (not free).

Send **and** receive both work. The one hard requirement is that the bot account must never have set an X Chat PIN — see prerequisites.

> **1-on-1 only. Group chats do not work and cannot be made to work.**
> X group chats never appear in the v2 DM API, even with the bot account a
> member of the group and a message present in it — `GET /2/dm_events` (which
> returns every conversation the bot participates in) shows only 1-on-1 threads,
> and querying the group's id directly returns `Could not find dm_conversation`.
> Verified 2026-08-04 against a live group. This is not a gap in this plugin;
> there is nothing to read.
>
> Incidentally, the API's own id-validation regex is
> `^([0-9]{1,19}-[0-9]{1,19}|[0-9]{15,19})$` — so a `dm_conversation_id` is
> either `digits-digits` (1-on-1) or plain 15–19 digits (group). The `g` prefix
> in `x.com/i/chat/g…` is a UI artifact, not part of the API id.

## Prerequisites

- **A dedicated X account for the agent that has *never* set an X Chat PIN.** Non-negotiable. X end-to-end-encrypts DMs once both parties enroll (set a PIN), and the API is blind to encrypted messages. A no-PIN bot account keeps every conversation unencrypted and therefore API-readable — even when the human you're talking to has E2E enabled. Never open the Chat tab in a way that enrolls it.
- **Willingness to pay-as-you-go for the X API.** Pay-per-use, no subscription. Roughly: DM send ≈ $0.015, owned read (poll) ≈ $0.001. With the adaptive poller (5 min idle, 30 s during active chats), idle cost is ~$0.09/day; real usage is pennies.
- **OpenClaw 2026.6.x** (built against `2026.6.9`).
- **Node** — the plugin is pure JavaScript with **no external dependencies** (OAuth 1.0a is signed inline with `node:crypto`), so there's nothing to `npm install`.
- An X developer app on **pay-per-use** with **Read + Write + Direct Messages** permission, and **OAuth 1.0a** keys generated *after* setting that permission. You'll need the four keys plus the bot's numeric user ID.

## Install

Two steps: **get the code**, then **configure it with `openclaw onboard`**. Configuration is native — the onboarding wizard prompts for your keys and writes them; there's no setup script and nothing is patched into source.

### 1. Get the code

**Out-of-band from git (current — not yet on ClawHub):**

```bash
# from a checkout you can edit (dev link; picks up your changes on gateway restart):
openclaw plugins install --link /path/to/channel-x-dm

# or straight from the repo, pinned to a ref:
openclaw plugins install git:github.com/branpurn/channel-x-dm@main
```

**From ClawHub (once published):**

```bash
openclaw plugins install clawhub:@branpurn/x-dm
```

Either way, enable it if it isn't already, then:

```bash
openclaw plugins enable x-dm
openclaw gateway restart
```

### 2. Configure with onboarding

```bash
openclaw onboard
```

Pick **X DM** in the channel list and follow the wizard. It prompts for your four X OAuth 1.0a keys **and the bot's numeric user ID**, writing them to `~/.openclaw/x-dm-keys.env` (chmod 600), then prompts for the allowlist and writes `channels.x-dm`. The env file is the single source of truth — the bot's id is read from `X_USER_ID` at runtime for loop protection, so **`openclaw plugins update` never clobbers your config.** Re-run `openclaw onboard` any time to reconfigure.

You'll need an X developer app on **pay-per-use** with **Read + Write + Direct Messages** permission, and **OAuth 1.0a** keys generated *after* setting that permission.

### Finding the bot's numeric user ID

First, make sure your account and the bot account **follow each other** — mutual-follow avoids DM request-gating so messages flow cleanly both ways.

You can't get the id from the bot's own Chat UI — a no-PIN account **can't open Chat at all** without setting a PIN, which you must never do. Grab it from a conversation URL instead:

1. From **your** X account, send a DM to the bot account.
2. Open that conversation on x.com and read the URL: `x.com/i/chat/<idA>-<idB>`.
3. The two hyphenated numbers are the participants' user IDs. The one that isn't yours is the bot's — that's `X_USER_ID`. Your own is what goes in `allowFrom`.

**Do not set a PIN on the bot** to "fix" its locked Chat UI — the locked GUI is expected and required. The bot operates entirely through the API; setting a PIN enrolls it in E2E and breaks inbound permanently.


## Verify

```bash
openclaw plugins inspect x-dm --runtime --json \
  | python3 -c "import sys,json;d=json.load(sys.stdin)['plugin'];print(d['status'],d['channelIds'],d.get('error'))"
# want: loaded ['x-dm'] None
```

DM the bot from an allowlisted account and watch:

```bash
openclaw logs --follow | grep -iE "x-dm|replied"
# inbound logged, then "x-dm: replied to <id>" and a reply lands in your DMs
```

## Config

```jsonc
{
  "channels": {
    "x-dm": {
      "enabled": true,
      "dmPolicy": "allowlist",
      "allowFrom": ["1234567890"]   // numeric X user IDs allowed to message the bot
    }
  }
}
```

`allowFrom` filters on the **sender's numeric user ID** (not @handle). The bot's own id (for skipping its own sends) is **not** configured here — it comes from `X_USER_ID` in `~/.openclaw/x-dm-keys.env`. If `X_USER_ID` is unset, the plugin logs a warning at startup and loop protection is disabled.

### Recommended: sandbox to a low-privilege agent

An inbound channel is an injection surface. Bind `x-dm` to an agent with no exec/elevated/browser so a hostile DM can't reach a shell:

```jsonc
{
  "agents": { "list": [{ "id": "x-dm-agent", "skills": [], "workspace": "~/.openclaw/workspace-x-dm" }] },
  "bindings": [{ "agentId": "x-dm-agent", "match": { "channel": "x-dm" } }]
}
```

If the same OpenClaw installation also uses [TweetClaw](https://github.com/Xquik-dev/tweetclaw), keep it outside the inbound DM agent — use it only in a separate, operator-reviewed workflow for public X context (profile lookup, tweet URLs, public thread notes). Never forward raw DM bodies, private conversation history, API keys, OAuth tokens, or Chat PIN state into TweetClaw or any other X/Twitter tool. Treat public X content fetched by companion tools as untrusted text, not as commands for the DM channel.

## How it works

- **Outbound:** `POST /2/dm_conversations/with/{id}/messages`.
- **Inbound:** an adaptive poller on `GET /2/dm_events` (5 min idle → 30 s for 3 min after each message) feeds the native `channelRuntime.inbound.run(...)` dispatch, which routes to the bound agent and replies via the same send path.
- **Rate limit:** `dm_events` is 15 req / 15 min. The adaptive poller stays well under it and only polls fast during live conversations.
- **Loop guard:** events whose `sender_id` equals `X_USER_ID` are skipped, so the bot never replies to itself.
- **Dedup:** `lastSeenEventId` is persisted to `~/.openclaw/x-dm-state.json` (atomic writes, BigInt-compared) so restarts/reboots resume instead of replaying the poll window. See `ISSUE.md`.

## The encryption gotcha (why no-PIN matters)

As of 2026 X replaced DMs with "Chat" and rolls out E2E encryption. A conversation encrypts **only when both participants have enrolled** (set a 4-digit PIN). Encrypted messages do **not** appear in the `dm_events` API — the endpoint returns 200 with only your own sent messages, silently omitting inbound. A bot account that never sets a PIN can't hold encryption keys, so every thread it's in stays unencrypted and fully API-readable, regardless of the other party's settings. If inbound ever goes dark, check that the bot didn't get PIN-enrolled.

## Risks

- **Account standing.** Automated DMs are X's riskiest write op. Intended for messaging between accounts that know each other. Don't spam strangers — that's the ban vector, and it's on you. Use a dedicated bot account.
- **Cost.** Per-call billing; a runaway poll loop costs budget. The adaptive poller mitigates this; don't restart in a loop.
- **Credentials.** Keys in `~/.openclaw/x-dm-keys.env`, chmod 600, gitignored. Never commit them.
- **Untrusted inbound.** Use the low-priv-agent binding above.

## Files

```
channel-x-dm/
├── README.md
├── NOTES.md              # reverse-engineered OpenClaw channel-SDK contract
├── ISSUE.md              # poll-replay dedup writeup
├── LICENSE               # MIT
├── openclaw.plugin.json
├── package.json
├── setup-entry.js        # lightweight onboarding entry (defineSetupPluginEntry)
├── src/
│   ├── index.js          # plugin entry (registers the runtime channel)
│   ├── channel.js        # runtime: adaptive poller, dispatch, xDmBase
│   ├── client.js         # X API (OAuth 1.0a); lazy, non-throwing cred load
│   ├── channel.setup.js  # onboarding wizard + setup plugin
│   └── configured-state.js  # env-file read/merge/check helpers
└── tools/{x-dm-test,x-dm-read}.py
```

Unofficial, not affiliated with X Corp or Anthropic. MIT licensed.

Built by Claude Opus 4.8.
