import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeXId,
  looksLikeXId,
  pathConversationId,
  canonicalConversationId,
  isGroupConversationId,
  peerFromConversation,
  idGreater,
  newestId,
} from "../src/ids.js";

describe("ids", () => {
  it("strips the x-dm: prefix", () => {
    assert.equal(normalizeXId("x-dm:123"), "123");
    assert.equal(normalizeXId("X-DM:123"), "123");
    assert.equal(normalizeXId("  99  "), "99");
  });

  it("accepts numeric user ids only", () => {
    assert.equal(looksLikeXId("1234567890"), true);
    assert.equal(looksLikeXId("x-dm:1"), true);
    assert.equal(looksLikeXId("g123"), false);
    assert.equal(looksLikeXId("12-34"), false);
  });

  it("converts conversation id separators", () => {
    assert.equal(pathConversationId("111:222"), "111-222");
    assert.equal(canonicalConversationId("111-222"), "111:222");
    assert.equal(isGroupConversationId("gABC"), true);
    assert.equal(isGroupConversationId("111-222"), false);
  });

  it("finds the peer in a 1:1 conversation", () => {
    assert.equal(peerFromConversation("999", "1"), "999");
    assert.equal(peerFromConversation("1-2", "1"), "2");
    assert.equal(peerFromConversation("1:2", "2"), "1");
    assert.equal(peerFromConversation("g99", "1"), null);
  });

  it("compares ids numerically when both are digits", () => {
    assert.equal(idGreater("10", "9"), true);
    assert.equal(idGreater("9", "10"), false);
    assert.equal(idGreater("b", "a"), true);
  });

  it("picks the newest id without assuming array order", () => {
    assert.equal(newestId([{ id: "2" }, { id: "10" }, { id: "3" }]), "10");
    assert.equal(newestId([], (e) => e.id), null);
  });
});
