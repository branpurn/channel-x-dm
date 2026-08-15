# X DM Channel for OpenClaw

Use X (Twitter) Direct Messages as a bidirectional channel for [OpenClaw](https://docs.openclaw.ai). Talk to your agent over X DMs. Uses the paid X API (not free).

Two **parallel transports** share one channel (`x-dm`), one allowlist, and one agent binding:

| Transport | API | Default | Bot account |
|-----------|-----|---------|-------------|
| **classic** | Unencrypted DM (`/2/dm_events`, `/2/dm_conversations/…`) | **yes** (until Chat is validated) | Must **never** set an X Chat PIN |
| **chat** | X Chat (`/2/chat/conversations`, encrypted via [chat-xdk](https://github.com/xdevplatform/chat-xdk)) | opt-in | Must **enroll** (public key + Juicebox PIN) |

Pick one transport **per bot account**. Chat enrollment encrypts the inbox and blinds classic inbound. Flip `channels.x-dm.transport` (or `DEFAULT_TRANSPORT` in `src/transport.js`) to `chat` once the Chat path is validated.

Send **and** receive both work on either transport.

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

- **A dedicated X account for the agent.**
  - **classic:** the account must *never* have set an X Chat PIN. X end-to-end-encrypts DMs once both parties enroll, and `dm_events` is blind to encrypted messages. A no-PIN bot keeps every thread unencrypted and API-readable — even when the human has E2E enabled. Never open the Chat tab in a way that enrolls it.
  - **chat:** the opposite. Register a public key and store the identity in Juicebox under `X_CHAT_PIN` (`node tools/x-chat-register.mjs --confirm`). That enrollment is what makes Chat decryptable, and it turns classic inbound dark on that account.
- **Willingness to pay-as-you-go for the X API.** Pay-per-use, no subscription. Roughly: DM send ≈ $0.015, owned read (poll) ≈ $0.001. With the adaptive poller (5 min idle, 90 s during active chats), idle cost is ~$0.09/day; real usage is pennies.
- **OpenClaw 2026.6.x** (built against `2026.6.9`).
- **Node** — classic is pure JavaScript with **no required dependencies** (OAuth 1.0a is signed inline with `node:crypto`). The Chat transport optionally needs `@xdevplatform/chat-xdk` and `juicebox-sdk` (`npm install` in the plugin directory).
- An X developer app on **pay-per-use** with **Read + Write + Direct Messages** permission, and **OAuth 1.0a** keys generated *after* setting that permission. You'll need the four keys plus the bot's numeric user ID. Chat can also use an optional OAuth 2.0 user-context token (`X_OAUTH2_ACCESS_TOKEN`, scopes `dm.read` + `dm.write`).

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

Pick **X DM** in the channel list and follow the wizard. It prompts for your four X OAuth 1.0a keys **and the bot's numeric user ID**, writing them to `~/.openclaw/x-dm-keys.env` (chmod 600), then the transport (`classic` default, or `chat`), optional Chat PIN / OAuth2 token, the allowlist, and `channels.x-dm`. The env file is the single source of truth — the bot's id is read from `X_USER_ID` at runtime for loop protection, so **`openclaw plugins update` never clobbers your config.** Re-run `openclaw onboard` any time to reconfigure.

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
      "transport": "classic",       // "classic" (default) | "chat" (opt-in X Chat API)
      "dmPolicy": "allowlist",
      "allowFrom": ["1234567890"]   // numeric X user IDs allowed to message the bot
    }
  }
}
```

`allowFrom` filters on the **sender's numeric user ID** (not @handle). The bot's own id (for skipping its own sends) is **not** configured here — it comes from `X_USER_ID` in `~/.openclaw/x-dm-keys.env`. If `X_USER_ID` is unset, the plugin stays dormant (loop protection cannot work).

`transport` can also be set as `X_DM_TRANSPORT` in the env file. Channel config wins when both are present.

### Opt-in: X Chat transport

Classic stays the default until this path is validated. To try Chat on a **dedicated** bot account:

1. `npm install` in the plugin directory (pulls optional `@xdevplatform/chat-xdk` + `juicebox-sdk`).
2. Set `X_CHAT_PIN` in `~/.openclaw/x-dm-keys.env` (4+ characters; not `0000` / `1234` / `4321`).
3. Register the bot identity once (rate-limited, a few writes / 24h):

```bash
node tools/x-chat-register.mjs --confirm
```

4. Set `channels.x-dm.transport` to `chat` (or `X_DM_TRANSPORT=chat`) and restart the gateway.
5. Confirm inbound:

```bash
node tools/x-chat-read.mjs <allowlisted-user-id>
```

Optional: `X_OAUTH2_ACCESS_TOKEN` (OAuth 2.0 user-context, `dm.read` + `dm.write`). If unset, Chat calls use the same OAuth 1.0a user context as classic.

When Chat is the supported default, change `DEFAULT_TRANSPORT` in `src/transport.js` and the schema default in `openclaw.plugin.json` from `classic` to `chat`.

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

Shared: allowlist / `dmPolicy`, `X_USER_ID` loop guard, drop-on-dispatch-error, adaptive idle/active cadence (5 min idle → 90 s for 3 min after inbound).

**classic (default)**

- **Outbound:** `POST /2/dm_conversations/with/{id}/messages`.
- **Inbound:** adaptive poller on `GET /2/dm_events` feeds `channelRuntime.inbound.run(...)`.
- **Rate limit:** `dm_events` is 15 req / 15 min.
- **Dedup:** `lastSeenEventId` in `~/.openclaw/x-dm-state.json` (atomic writes, BigInt-compared). See `ISSUE.md`.

**chat (opt-in)**

- **Outbound:** encrypt + sign with chat-xdk, then `POST /2/chat/conversations/{id}/messages`. Initializes conversation keys (`POST …/keys`) on first send to a peer.
- **Inbound:** poll each allowlisted 1:1 (`GET /2/chat/conversations/{id}/events`). Under `pairing` / `open`, also lists `GET /2/chat/conversations` so unknown senders can pair. Groups (`g…`) are skipped — still 1-on-1 only.
- **Keys:** unlock the bot identity from Juicebox with `X_CHAT_PIN`; batch-decrypt `meta.conversation_key_events` so message decrypt can succeed.
- **Dedup:** per-peer `lastSeenEventId` in `~/.openclaw/x-chat-state.json`. First poll seeds and ignores backlog, same as classic.

## The encryption gotcha (why the two transports cannot share an account)

As of 2026 X replaced DMs with "Chat" and rolls out E2E encryption. A conversation encrypts **only when both participants have enrolled** (set a PIN / registered a public key).

- **classic** reads `dm_events`. Encrypted messages do **not** appear there — the endpoint returns 200 with only your own sent messages, silently omitting inbound. A bot that never enrolls can't hold encryption keys, so every thread it's in stays unencrypted and API-readable. If classic inbound goes dark, the bot was PIN-enrolled.
- **chat** is the enrolled path: the plugin holds the identity (Juicebox + `X_CHAT_PIN`) and decrypts `/2/chat/conversations/{id}/events` with chat-xdk. That is the new API (public keys, conversation keys, encrypted send). It is opt-in until validated; then it becomes the default.

## Risks

- **Account standing.** Automated DMs are X's riskiest write op. Intended for messaging between accounts that know each other. Don't spam strangers — that's the ban vector, and it's on you. Use a dedicated bot account.
- **Cost.** Per-call billing; a runaway poll loop costs budget. The adaptive poller mitigates this; don't restart in a loop.
- **Credentials.** Keys (and the Chat PIN) in `~/.openclaw/x-dm-keys.env`, chmod 600, gitignored. Never commit them. Juicebox recovery is PIN-guess-limited — a wrong `X_CHAT_PIN` can lock the identity.
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
├── src/
│   ├── index.js          # plugin entry (registers the runtime channel)
│   ├── setup-entry.js    # onboarding entry (defineBundledChannelSetupEntry)
│   ├── channel.js        # xDmBase + transport switch (classic default)
│   ├── transport.js      # DEFAULT_TRANSPORT + resolveTransport
│   ├── classic-transport.js  # unencrypted DM poller
│   ├── chat-transport.js # X Chat poller (opt-in)
│   ├── client.js         # classic DM API
│   ├── chat-client.js    # /2/chat/* + public_keys HTTP
│   ├── chat-crypto.js    # lazy chat-xdk / Juicebox session
│   ├── oauth.js          # OAuth 1.0a + optional OAuth2 fetch
│   ├── ids.js            # user / conversation id helpers
│   ├── dispatch.js       # shared inbound.run adapter
│   ├── poll-utils.js     # interruptible sleep + atomic state
│   ├── channel.setup.js  # onboarding wizard + setup plugin
│   └── configured-state.js  # env-file read/merge/check helpers
├── test/*.test.js
└── tools/{x-dm-test,x-dm-read}.py + {x-chat-register,x-chat-read}.mjs
```

Unofficial, not affiliated with X Corp or Anthropic. MIT licensed.

Built by Claude Opus 4.8.
