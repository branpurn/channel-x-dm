#!/usr/bin/env node
// One-time X Chat public-key registration for the bot account.
//
// Rate-limited (a few writes / 24h). Run once, then set transport=chat.
// Requires X_CHAT_PIN and the four OAuth keys in ~/.openclaw/x-dm-keys.env.
// Optional: X_OAUTH2_ACCESS_TOKEN (preferred by official Chat examples).
//
//   node tools/x-chat-register.mjs --confirm
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readXDmEnv, mergeXDmEnv } from "../src/configured-state.js";
import { botUserId, isConfigured } from "../src/client.js";
import { addUserPublicKey, getUserPublicKeys, juiceboxConfigJson, loadRealmTokens } from "../src/chat-client.js";
import { chatPin, weakPinReason } from "../src/chat-crypto.js";

const MARKER = path.join(os.homedir(), ".openclaw", "x-chat-register.json");

function readMarker() {
  try {
    return JSON.parse(fs.readFileSync(MARKER, "utf8"));
  } catch {
    return {};
  }
}

function writeMarker(value) {
  fs.mkdirSync(path.dirname(MARKER), { recursive: true });
  fs.writeFileSync(MARKER, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

async function loadCreateChat() {
  const mod = await import("@xdevplatform/chat-xdk");
  return mod.createChat;
}

async function register({ force }) {
  if (!isConfigured()) {
    console.error("Missing X OAuth keys in ~/.openclaw/x-dm-keys.env — run openclaw onboard first.");
    process.exit(1);
  }
  const pin = chatPin();
  if (!pin) {
    console.error("Set X_CHAT_PIN in ~/.openclaw/x-dm-keys.env (Juicebox recovery PIN).");
    process.exit(1);
  }
  const weak = weakPinReason(pin);
  if (weak) {
    console.error(`X_CHAT_PIN ${weak}. Pick a stronger PIN before registering.`);
    process.exit(1);
  }

  const userId = botUserId() || readXDmEnv().X_USER_ID;
  if (!userId) {
    console.error("Set X_USER_ID in ~/.openclaw/x-dm-keys.env.");
    process.exit(1);
  }

  const marker = readMarker();
  if (marker.registered && !force) {
    console.error(`Already registered (version ${marker.version}). Pass --force only to mint a NEW identity.`);
    process.exit(1);
  }

  const createChat = await loadCreateChat();
  const realmTokens = new Map();
  const getAuthToken = async (realmId) => realmTokens.get(String(realmId).toLowerCase()) ?? "";
  const chat = await createChat({ getAuthToken });

  let body;
  let version;
  let minted = false;
  if (marker.body && !force) {
    const existing = await getUserPublicKeys(userId);
    const cfg = juiceboxConfigJson(existing);
    if (!cfg) {
      console.error("Saved registration body but no juicebox_config on the account. Re-run with --force.");
      process.exit(1);
    }
    for (const [k, v] of loadRealmTokens(cfg)) realmTokens.set(k, v);
    chat.updateConfig(cfg);
    await chat.unlock(pin);
    body = marker.body;
    version = String(marker.version ?? "1");
    console.log("Resuming the saved identity (recovered from Juicebox).");
  } else {
    const reg = chat.generateKeypairs();
    version = String(reg.version ?? "1");
    body = {
      public_key: {
        public_key: reg.publicKey.publicKey,
        signing_public_key: reg.publicKey.signingPublicKey,
        identity_public_key_signature: reg.publicKey.identityPublicKeySignature,
        signing_public_key_signature: reg.publicKey.signingPublicKeySignature,
        registration_method: reg.publicKey.registrationMethod,
      },
      version,
      generate_version: Boolean(reg.generateVersion),
    };
    minted = true;
    console.log("Generated a new identity.");
  }

  const ourPublicKey = body.public_key.public_key;
  const existing = await getUserPublicKeys(userId);
  const already = existing.find((k) => k.public_key === ourPublicKey);
  if (already) {
    version = already.public_key_version || version;
    console.log(`Public key already registered (version ${version}); skipping POST.`);
  } else {
    console.log(`Registering public key version ${version} …`);
    try {
      const resp = await addUserPublicKey(userId, body);
      let data = resp.data?.data ?? {};
      if (Array.isArray(data)) data = data[0] ?? {};
      version = String(data.public_key_version ?? data.publicKeyVersion ?? version);
    } catch (err) {
      if (err.status === 429) {
        const when = err.resetEpoch ? new Date(err.resetEpoch * 1000).toISOString() : "the next window";
        console.error(`Registration rate limited (429). Wait until ${when} and re-run.`);
        process.exit(1);
      }
      throw err;
    }
  }

  // Persist the registration body before Juicebox setup so a crash after the
  // rate-limited POST can resume the same identity instead of minting another.
  writeMarker({ body, version, user_id: userId });

  if (minted) {
    const keys = await getUserPublicKeys(userId);
    const cfg = juiceboxConfigJson(keys);
    if (!cfg) {
      console.error("Public key POST succeeded but juicebox_config is missing. Re-run to resume.");
      process.exit(1);
    }
    for (const [k, v] of loadRealmTokens(cfg)) realmTokens.set(k, v);
    chat.updateConfig(cfg);
    try {
      await chat.setup(pin);
    } catch (err) {
      console.error(
        `Storing keys in Juicebox failed after public key version ${version} was registered. ` +
          "Re-run without --force to resume this identity."
      );
      throw err;
    }
    console.log("Keys stored in Juicebox under X_CHAT_PIN.");
  }

  mergeXDmEnv({ X_CHAT_SIGNING_KEY_VERSION: String(version) });
  writeMarker({
    registered: true,
    user_id: userId,
    version,
    body,
    registered_at: new Date().toISOString(),
  });
  console.log();
  console.log("Registration complete.");
  console.log(`  version: ${version}`);
  console.log("Set channels.x-dm.transport=chat and restart the gateway to use the Chat path.");
}

const args = new Set(process.argv.slice(2));
if (!args.has("--confirm") && !args.has("--force")) {
  console.log("Registers a bot X Chat identity (rate-limited, one-time).");
  console.log("Re-run with --confirm when ready: node tools/x-chat-register.mjs --confirm");
  process.exit(0);
}

await register({ force: args.has("--force") });
