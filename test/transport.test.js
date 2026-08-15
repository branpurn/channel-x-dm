import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRANSPORT, normalizeTransport, resolveTransport, CHANNEL_ID } from "../src/transport.js";

describe("transport", () => {
  it("defaults to classic until Chat is validated", () => {
    assert.equal(DEFAULT_TRANSPORT, "classic");
    assert.equal(CHANNEL_ID, "x-dm");
  });

  it("normalizes unknown values to classic", () => {
    assert.equal(normalizeTransport("chat"), "chat");
    assert.equal(normalizeTransport("CHAT"), "chat");
    assert.equal(normalizeTransport("classic"), "classic");
    assert.equal(normalizeTransport("nope"), "classic");
    assert.equal(normalizeTransport(""), "classic");
    assert.equal(normalizeTransport(undefined), "classic");
  });

  it("prefers channels.x-dm.transport over the default", () => {
    assert.equal(resolveTransport({ channels: { "x-dm": { transport: "chat" } } }), "chat");
    assert.equal(resolveTransport({ channels: { "x-dm": { transport: "classic" } } }), "classic");
  });
});
