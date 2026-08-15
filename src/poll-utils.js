import fs from "node:fs";

// Interruptible sleep. The abort listener MUST be removed on the normal
// timeout path: { once: true } only detaches after the event fires, and
// abort doesn't fire during normal operation — so a leaked listener per
// poll would accumulate on a signal that lives as long as the process.
export function sleep(ms, abortSignal) {
  return new Promise((resolve) => {
    let timer;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      abortSignal?.removeEventListener?.("abort", onAbort);
      resolve();
    }, ms);
    abortSignal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

export function awaitAbort(abortSignal) {
  return new Promise((resolve) => {
    if (abortSignal?.aborted) return resolve();
    abortSignal?.addEventListener?.("abort", () => resolve(), { once: true });
  });
}

export function loadJsonState(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

export function saveJsonState(filePath, value) {
  try {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, filePath); // atomic on POSIX
  } catch {
    /* best-effort */
  }
}
