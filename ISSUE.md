# Inbound poller replays the entire DM window on restart/reboot

## Summary

The X DM channel re-dispatches previously-handled inbound messages whenever the gateway restarts or the host reboots, causing the agent to re-reply to old messages (and, in some cases, re-flush old replies verbatim from the durable outbound queue).

## Severity

Medium — no data loss, but produces duplicate/old replies sent to real recipients on every restart. Cosmetically alarming and burns API send credit.

## Root cause

Unlike the bundled channels (Signal, SMS), which are **webhook-driven** and receive each inbound event exactly once, the X DM channel **polls** `GET /2/dm_events`. The dedup marker (`lastSeenEventId`) tracking which events were already processed was **in-memory only**, initialized to `null` on every `startAccount`. On restart:

1. Poller starts with `lastSeenEventId = null`.
2. First poll reads the current `dm_events` window (which still contains recent messages).
3. With no memory of what was handled, every event in the window is treated as new and re-dispatched.

Because OpenClaw's `inbound.run` dispatch layer does **not** dedup poll-replays (it was designed around webhook delivery, which is inherently once-only — confirmed by inspecting `inbound-reply-dispatch-*.js`, which exposes `recordInboundSession` but no event-level idempotency), dedup is the polling channel's responsibility.

A secondary effect: turns whose compaction failed mid-flight (separate issue) left replies un-acknowledged in the durable outbound queue, which then re-flushed verbatim on restart.

## Fix

Persist the dedup marker to disk and seed it correctly on first run. Implemented in `src/channel.js`:

- **Disk-persisted `lastSeenEventId`** in `~/.openclaw/x-dm-state.json`, loaded on `startAccount`, so restarts/reboots resume from the last handled event instead of replaying the window.
- **First-run seeding:** with no prior state, adopt the newest current event as the marker and dispatch nothing (ignore backlog) — so a fresh install/reboot never replays pre-existing history.
- **At-least-once with drop-on-dispatch-error:** the marker advances per event even if dispatch throws, avoiding poison-message retry loops. Documented tradeoff: a transient dispatch error drops that one message rather than retrying (acceptable for a personal channel; the alternative risks infinite retries on a permanently-failing message).

### QA hardening (caught in review)

- **BigInt ID comparison** (`idGreater`) instead of string comparison. Snowflake IDs sort lexically == numerically *only while digit length is constant*; a future roll to longer IDs would silently skip newer messages under string compare. BigInt compare is correct regardless.
- **Atomic state writes** (temp file + `rename`) so a crash mid-write can't corrupt the marker file (which would otherwise degrade into replay or message-loss on next start).
- **Order-independent newest detection** — compute the newest ID by value rather than assuming API return order.
- **One disk write per poll batch** instead of per-event, avoiding a write storm.

## Known limitations (documented, not fixed)

- **Pagination:** only the first `dm_events` page is processed per poll. Not a concern at personal/low message volume; would need cursor-following for high throughput.
- **Concurrent pollers:** if two `startAccount` instances overlap (e.g. a lingering old process during a botched restart), they race the state write. The atomic rename means worst case is last-writer-wins with a valid file, not corruption.

## Testing

- Fresh start with seeded state → `poll (idle)`, zero replays, backlog ignored. ✅
- New inbound after start → single dispatch + single reply. ✅
- **Reboot → startup logs `lastSeen=<id>` from disk, no replay.** ✅ (primary regression test)
