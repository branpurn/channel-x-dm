// Lightweight config-state + env-file helpers for x-dm setup surfaces.
// Deliberately imports nothing heavy (no oauth-1.0a), so it stays cheap for the
// setup entry and for the manifest `openclaw.channel.configuredState` hook.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ENV_PATH = path.join(os.homedir(), ".openclaw", "x-dm-keys.env");
const REQUIRED = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_SECRET"];

// Parse the KEY=value env file. Returns {} if it doesn't exist (never throws).
export function readXDmEnv() {
  let text;
  try {
    text = fs.readFileSync(ENV_PATH, "utf8");
  } catch {
    return {};
  }
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !t.startsWith("#") && t.includes("=")) {
      const i = t.indexOf("=");
      out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
  return out;
}

// Merge a patch into the env file, preserving existing keys. chmod 600.
export function mergeXDmEnv(patch) {
  const merged = { ...readXDmEnv(), ...patch };
  const body =
    Object.entries(merged)
      .filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") + "\n";
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  fs.writeFileSync(ENV_PATH, body, { mode: 0o600 });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch {
    /* best effort */
  }
}

// True once all four OAuth keys are present on disk.
export function isXDmConfigured() {
  const env = readXDmEnv();
  return REQUIRED.every((k) => env[k]);
}

// Manifest `openclaw.channel.configuredState` hook (mirrors Discord's
// hasDiscordConfiguredState). Called by config-state surfaces before the
// runtime loads. Signature is best-effort — verify against `openclaw onboard`.
export function hasXDmConfiguredState() {
  return isXDmConfigured();
}
