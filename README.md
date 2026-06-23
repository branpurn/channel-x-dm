# X DM (Unencrypted) Channel for OpenClaw

Use legacy **unencrypted** X (Twitter) Direct Messages as a bidirectional channel for [OpenClaw](https://docs.openclaw.ai). Talk to your agent over X DMs. Uses the paid X API (not free).

Send **and** receive both work. The one hard requirement is that the bot account must never have set an X Chat PIN — see prerequisites.

## Prerequisites

- **A dedicated X account for the agent that has *never* set an X Chat PIN.** This is non-negotiable. X end-to-end-encrypts DMs once both parties enroll (set a PIN), and the API is blind to encrypted messages. A no-PIN bot account keeps every conversation unencrypted and therefore API-readable — even when the human you're talking to has E2E enabled. Never open the Chat tab in a way that enrolls it, ever.
- **Willingness to pay-as-you-go for the X API.** Pay-per-use, no subscription. Roughly: DM send ≈ $0.015, owned read (poll) ≈ $0.001. With the adaptive poller (5 min idle, 30 s during active chats), idle cost is ~$0.09/day; real usage is pennies. Heavy back-and-forth is still cents, not dollars.
- **OpenClaw 2026.6.x** (built against `2026.6.9`).
- **Node** + `npm` (the plugin's one dependency, `oauth-1.0a`, installs locally).

## Setup

```bash
git clone <your-repo-url> openclaw-x-dm
cd openclaw-x-dm
./setup.sh
```

`setup.sh` installs the plugin to `~/.openclaw/extensions/x-dm/`, installs deps, prompts for your X OAuth 1.0a keys (written to `~/.openclaw/x-dm-keys.env`, chmod 600), registers the channel, restarts the gateway, and verifies registration.

You'll need an X developer app on **pay-per-use** with **Read + Write + Direct Messages** permission, and **OAuth 1.0a** keys generated *after* setting that permission. The four keys + the bot's numeric user ID go in the env file.

### Finding the bot's numeric user ID

First, make sure your account and the bot account **follow each other** — mutual-follow avoids DM request-gating so messages flow cleanly in both directions.

Setup needs the bot's numeric user ID (`X_USER_ID`). You can't get it from the bot's own Chat UI — a no-PIN account **can't open Chat at all** without setting a PIN, which you must never do. Instead, grab it from a conversation URL:

1. From **your** X account, send a DM to the bot account.
2. Open that conversation on x.com and look at the URL: `x.com/i/chat/<idA>-<idB>`.
3. The two hyphenated numbers are the participants' user IDs. The one that isn't yours is the bot's.

That number is `X_USER_ID` (and the bot's entry if you ever allowlist it). Your own ID from the same URL is what goes in `allowFrom`.

**Do not set a PIN on the bot** to "fix" its locked Chat UI — the locked GUI is expected and required. The bot operates entirely through the API; it never needs Chat access. Setting a PIN enrolls it in E2E and breaks inbound permanently.

## Verify

```bash
openclaw plugins inspect x-dm --runtime --json \
  | python3 -c "import sys,json;d=json.load(sys.stdin)['plugin'];print(d['status'],d['channelIds'],d.get('error'))"
# want: loaded ['x-dm'] None
```

DM the bot from an allowlisted account; watch:

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
      "allowFrom": ["2677902860"]   // numeric X user IDs allowed to message the bot
    }
  }
}
```

`allowFrom` filters on the **sender's numeric user ID** (not @handle). Set `BOT_USER_ID` in `src/channel.js` to your bot's numeric ID so the poller skips its own sends.

### Recommended: sandbox to a low-privilege agent

An inbound channel is an injection surface. Bind `x-dm` to an agent with no exec/elevated/browser so a hostile DM can't reach a shell:

```jsonc
{
  "agents": { "list": [{ "id": "x-dm-agent", "skills": [], "workspace": "~/.openclaw/workspace-x-dm" }] },
  "bindings": [{ "agentId": "x-dm-agent", "match": { "channel": "x-dm" } }]
}
```

## How it works

- **Outbound:** `POST /2/dm_conversations/with/{id}/messages`.
- **Inbound:** an adaptive poller on `GET /2/dm_events` (5 min idle → 30 s for 3 min after each message) feeds the native `channelRuntime.inbound.run(...)` dispatch, which routes to the bound agent and replies via the same send path.
- **Rate limit:** `dm_events` is 15 req / 15 min. The adaptive poller stays well under it and only polls fast during live conversations.

## The encryption gotcha (why no-PIN matters)

As of 2026 X replaced DMs with "Chat" and rolls out E2E encryption. A conversation encrypts **only when both participants have enrolled** (set a 4-digit PIN). Encrypted messages do **not** appear in the `dm_events` API — the endpoint returns 200 with only your own sent messages, silently omitting inbound. A bot account that never sets a PIN can't hold encryption keys, so every thread it's in stays unencrypted and fully API-readable, regardless of the other party's settings. That's why the no-PIN bot account is the whole trick. If inbound ever goes dark, check that the bot didn't get PIN-enrolled.

## Risks

- **Account standing.** Automated DMs are X's riskiest write op. Intended for messaging between accounts that know each other. Don't spam strangers — that's the ban vector, and it's on you. Use a dedicated bot account.
- **Cost.** Per-call billing; a runaway poll loop costs budget. The adaptive poller mitigates this; don't restart in a loop.
- **Credentials.** Keys in `~/.openclaw/x-dm-keys.env`, chmod 600, gitignored. Never commit them.
- **Untrusted inbound.** Use the low-priv-agent binding above.

## Files

```
openclaw-x-dm/
├── README.md
├── NOTES.md              # reverse-engineered OpenClaw channel-SDK contract
├── LICENSE               # MIT
├── setup.sh
├── openclaw.plugin.json
├── package.json
├── src/{index,channel,client}.js
└── tools/{x-dm-test,x-dm-read}.py
```

Unofficial, not affiliated with X Corp or Anthropic. MIT licensed.

Built by Claude Opus 4.8.
