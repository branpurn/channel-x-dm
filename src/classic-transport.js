import os from "node:os";
import { sendDm, fetchDmEvents } from "./client.js";
import { dispatchInbound } from "./dispatch.js";
import { idGreater, newestId } from "./ids.js";
import { loadJsonState, saveJsonState, sleep } from "./poll-utils.js";

const STATE_FILE = `${os.homedir()}/.openclaw/x-dm-state.json`;

// Poll cadence is bounded by the X API budget, not by how responsive we'd like
// to be. Observed on GET /2/dm_events: 15 requests per 15-minute window (the
// x-rate-limit-* headers decrement by 1 per poll and reset on the quarter hour).
// That is one request per 60s sustained. The old 30s active cadence was exactly
// 2x over budget, so a live conversation — the moment responsiveness matters —
// burned the window and then ate 429s until it rolled over.
const IDLE_MS = 300000;          // 5 min when quiet (3 req/window)
const ACTIVE_MS = 90000;         // 90 s during a live conversation (10 req/window)
const ACTIVE_WINDOW_MS = 180000; // stay "active" 3 min after last inbound
// Below this many remaining requests, stop polling until the window resets
// rather than spending the last of the budget and failing closed.
const RATE_LIMIT_FLOOR = 2;

// --- persistent dedup marker (survives restarts/reboots) ---
// Semantics: at-least-once on the read side, drop-on-error on dispatch.
// The marker advances once per poll batch (and per event, even if dispatch
// throws). Consequence: a transient dispatch error (e.g. model hiccup) drops
// that one message rather than retrying it. This is deliberate — retrying a
// permanently-failing ("poison") message would loop forever every poll. For a
// personal agent, a rare dropped reply you can just re-send beats both a retry
// loop and reboot-replay spam.
function loadLastSeen() {
  const j = loadJsonState(STATE_FILE, {});
  return typeof j.lastSeenEventId === "string" ? j.lastSeenEventId : null;
}
function saveLastSeen(id) {
  if (!id) return;
  saveJsonState(STATE_FILE, { lastSeenEventId: id });
}

export async function sendClassicText(recipientId, text) {
  return sendDm(recipientId, text);
}

export async function startClassicAccount(ctx, { account, botId }) {
  const log = ctx?.log ?? console;
  let lastSeenEventId = loadLastSeen();
  log.info?.(`x-dm: startAccount — classic DM poller (lastSeen=${lastSeenEventId ?? "none"})`);

  let lastInboundAt = 0;
  let stopped = false;
  // Set when the API budget is spent; poll() hands the loop a deadline to
  // sleep to instead of its normal cadence.
  let rateLimitResumeAt = 0;

  const poll = async () => {
    try {
      const { data, limit, remaining, reset } = await fetchDmEvents();

      // Park until the window rolls over if we're down to the last of the
      // budget. Falls back to one idle interval when the reset header is
      // missing or nonsensical.
      const remainingNum = Number(remaining);
      if (Number.isFinite(remainingNum) && remainingNum <= RATE_LIMIT_FLOOR) {
        const resetMs = Number(reset) * 1000;
        const until =
          Number.isFinite(resetMs) && resetMs > Date.now() ? resetMs : Date.now() + IDLE_MS;
        rateLimitResumeAt = until;
        log.warn?.(
          `x-dm: rate limit nearly exhausted (${remaining}/${limit}) — pausing ${Math.ceil(
            (until - Date.now()) / 1000
          )}s until window reset`
        );
      }

      const all = data?.data ?? [];
      const msgs = all.filter((e) => e.event_type === "MessageCreate");

      // FIRST RUN (no marker): adopt newest, dispatch nothing (ignore backlog).
      if (lastSeenEventId === null) {
        const newest = newestId(msgs);
        if (newest) {
          lastSeenEventId = newest;
          saveLastSeen(lastSeenEventId);
          log.info?.(`x-dm: seeded lastSeen=${lastSeenEventId} (backlog ignored)`);
        }
        log.info?.(`x-dm: poll (seed) — ${all.length} events (rl ${remaining}/${limit})`);
        return;
      }

      // strictly-newer events, oldest-first by numeric value
      const fresh = msgs
        .filter((e) => idGreater(e.id, lastSeenEventId))
        .sort((a, b) => (idGreater(a.id, b.id) ? 1 : -1));

      let gotInbound = false;
      let newMarker = lastSeenEventId;
      for (const e of fresh) {
        // Advance the marker even on dispatch failure (see header comment:
        // drop-on-error, not retry — avoids poison-message loops).
        if (idGreater(e.id, newMarker)) newMarker = e.id;
        if (botId && String(e.sender_id) === botId) continue; // skip own sends
        gotInbound = true;
        log.info?.(`x-dm: inbound from ${e.sender_id}: ${String(e.text ?? "").slice(0, 40)}`);
        try {
          await dispatchInbound(ctx, account, e, sendDm);
        } catch (err) {
          log.warn?.(`x-dm: dispatch error (message dropped): ${err.message}`);
        }
      }

      if (newMarker !== lastSeenEventId) {
        lastSeenEventId = newMarker;
        saveLastSeen(lastSeenEventId); // one write per batch
      }
      if (gotInbound) lastInboundAt = Date.now();
      const active = Date.now() - lastInboundAt < ACTIVE_WINDOW_MS;
      log.info?.(`x-dm: poll (${active ? "active" : "idle"}) — ${all.length} events (rl ${remaining}/${limit})`);
    } catch (err) {
      log.warn?.(`x-dm poll error: ${err.message}`);
    }
  };

  const loop = async () => {
    while (!stopped) {
      await poll();
      const active = Date.now() - lastInboundAt < ACTIVE_WINDOW_MS;
      const wait = active ? ACTIVE_MS : IDLE_MS;
      // A rate-limit pause outranks the normal cadence.
      const untilReset = rateLimitResumeAt - Date.now();
      await sleep(Math.max(wait, untilReset > 0 ? untilReset : 0), ctx?.abortSignal);
    }
  };

  const runner = loop();
  await new Promise((resolve) => {
    const sig = ctx?.abortSignal;
    if (sig?.aborted) {
      stopped = true;
      return resolve();
    }
    sig?.addEventListener?.(
      "abort",
      () => {
        stopped = true;
        resolve();
      },
      { once: true }
    );
  });
  await runner;
}
