#!/usr/bin/env bash
#
# setup.sh — install the x-dm channel into OpenClaw.
# Copies the plugin, installs deps, collects OAuth 1.0a keys (chmod 600 env),
# sets the bot's numeric ID into channel.js, registers config, restarts, verifies.
# Safe to re-run. Does NOT echo secrets. Does NOT commit anything.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="${HOME}/.openclaw/extensions/x-dm"
ENV_FILE="${HOME}/.openclaw/x-dm-keys.env"

say()  { printf '\033[1;36m[x-dm]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[x-dm]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x-dm]\033[0m %s\n' "$*" >&2; exit 1; }

command -v openclaw >/dev/null 2>&1 || die "openclaw CLI not found on PATH."
command -v npm      >/dev/null 2>&1 || die "npm not found on PATH."
command -v node     >/dev/null 2>&1 || die "node not found on PATH."

say "Installing x-dm into ${EXT_DIR}"
mkdir -p "${EXT_DIR}"
cp -f "${SCRIPT_DIR}/src/index.js"         "${EXT_DIR}/index.js"
cp -f "${SCRIPT_DIR}/src/channel.js"       "${EXT_DIR}/channel.js"
cp -f "${SCRIPT_DIR}/src/client.js"        "${EXT_DIR}/client.js"
cp -f "${SCRIPT_DIR}/openclaw.plugin.json" "${EXT_DIR}/openclaw.plugin.json"
cp -f "${SCRIPT_DIR}/package.json"         "${EXT_DIR}/package.json"

say "Installing deps..."
( cd "${EXT_DIR}" && npm install --silent ) || die "npm install failed."

# Credentials
if [[ -f "${ENV_FILE}" ]]; then
  say "Found existing ${ENV_FILE} — leaving it untouched."
else
  say "Enter X OAuth 1.0a credentials (written only to ${ENV_FILE}, chmod 600)."
  say "App needs Read+Write+Direct Messages; generate tokens AFTER setting that."
  read -rp  "  Consumer Key (X_API_KEY):        " X_API_KEY
  read -rsp "  Consumer Secret (X_API_SECRET):  " X_API_SECRET; echo
  read -rp  "  Access Token (X_ACCESS_TOKEN):   " X_ACCESS_TOKEN
  read -rsp "  Access Secret (X_ACCESS_SECRET): " X_ACCESS_SECRET; echo
  read -rp  "  Bot numeric user id (X_USER_ID): " X_USER_ID
  ( umask 177; cat > "${ENV_FILE}" <<EOF2
X_API_KEY=${X_API_KEY}
X_API_SECRET=${X_API_SECRET}
X_ACCESS_TOKEN=${X_ACCESS_TOKEN}
X_ACCESS_SECRET=${X_ACCESS_SECRET}
X_USER_ID=${X_USER_ID}
EOF2
  )
  chmod 600 "${ENV_FILE}"
  unset X_API_SECRET X_ACCESS_SECRET
  say "Credentials written (chmod 600)."
fi

# Patch BOT_USER_ID into channel.js from the env file (skips bot's own sends)
BOT_ID="$(grep '^X_USER_ID=' "${ENV_FILE}" | cut -d= -f2- | tr -d '[:space:]')"
if [[ -n "${BOT_ID}" ]]; then
  sed -i "s/^const BOT_USER_ID = \".*\";/const BOT_USER_ID = \"${BOT_ID}\";/" "${EXT_DIR}/channel.js"
  say "Set BOT_USER_ID=${BOT_ID} in channel.js"
else
  warn "X_USER_ID not found in env; set BOT_USER_ID in channel.js manually or replies may loop."
fi

# Allowlist
echo
say "Numeric X user IDs allowed to DM the bot (comma-separated):"
read -rp "  allowFrom: " ALLOW_RAW
ALLOW_JSON="$(python3 - "$ALLOW_RAW" <<'PY'
import json, sys
ids = [x.strip() for x in (sys.argv[1] if len(sys.argv)>1 else "").split(",") if x.strip()]
print(json.dumps(ids))
PY
)"
[[ "${ALLOW_JSON}" != "[]" ]] || warn "Empty allowlist — no inbound will be accepted (dmPolicy=allowlist)."

say "Registering plugin + channel config..."
openclaw config set plugins.entries.x-dm.enabled true   >/dev/null
openclaw config set channels.x-dm.enabled true          >/dev/null
openclaw config set channels.x-dm.dmPolicy allowlist    >/dev/null
openclaw config set channels.x-dm.allowFrom "${ALLOW_JSON}" >/dev/null

say "Restarting gateway..."
openclaw gateway restart >/dev/null 2>&1 || warn "restart returned non-zero; check 'openclaw gateway status'."
sleep 3

VERIFY="$(openclaw plugins inspect x-dm --runtime --json 2>/dev/null \
  | python3 -c "import sys,json;d=json.load(sys.stdin)['plugin'];print(d['status'], d['channelIds'], d.get('error'))" 2>/dev/null || echo "inspect-failed")"
echo
if echo "${VERIFY}" | grep -q "x-dm"; then
  say "SUCCESS — ${VERIFY}"
  say "Watch:  openclaw logs --follow | grep -i x-dm"
  warn "Bot account must NEVER set an X Chat PIN, or inbound goes E2E-dark. See README."
else
  warn "Did not register cleanly: ${VERIFY}"
  warn "Check: openclaw plugins inspect x-dm --runtime --json  (see NOTES.md)"
fi
