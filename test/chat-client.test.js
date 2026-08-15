import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  latestPublicKey,
  normalizePublicKey,
  signingKeyEntry,
  prepToRequest,
  encryptPayloadToSendBody,
  loadRealmTokens,
  juiceboxConfigJson,
} from "../src/chat-client.js";
import { weakPinReason } from "../src/chat-pin.js";
import { _internals } from "../src/chat-transport.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

describe("chat-client helpers", () => {
  it("picks the highest public_key_version", () => {
    const latest = latestPublicKey([
      { public_key_version: "1", public_key: "a" },
      { publicKeyVersion: "3", publicKey: "c" },
      { public_key_version: "2", public_key: "b" },
    ]);
    assert.equal(latest.publicKey, "c");
  });

  it("normalizes camelCase and snake_case public keys", () => {
    const n = normalizePublicKey(
      {
        publicKey: "pk",
        signingPublicKey: "sk",
        identityPublicKeySignature: "sig",
        publicKeyVersion: "7",
      },
      "99"
    );
    assert.deepEqual(n, {
      user_id: "99",
      public_key: "pk",
      signing_public_key: "sk",
      identity_public_key_signature: "sig",
      public_key_version: "7",
      juicebox_config: null,
    });
    const entry = signingKeyEntry(n, "99");
    assert.equal(entry.userId, "99");
    assert.equal(entry.publicKey, "sk");
    assert.equal(entry.identityPublicKey, "pk");
  });

  it("maps a key-change prep into the OpenAPI snake_case body", () => {
    const body = prepToRequest(
      {
        conversationKeyVersion: "v2",
        participantKeys: [
          { userId: "1", encryptedKey: "enc1", publicKeyVersion: "1" },
          { user_id: "2", encrypted_key: "enc2", public_key_version: "1" },
        ],
        actionSignatures: [
          {
            messageId: "m1",
            encodedMessageEventDetail: "det",
            signature: "sig",
            signatureVersion: "1",
            publicKeyVersion: "1",
          },
        ],
      },
      "bot-signing"
    );
    assert.equal(body.conversation_key_version, "v2");
    assert.equal(body.conversation_participant_keys[1].user_id, "2");
    assert.equal(body.action_signatures[0].message_event_signature.signing_public_key, "bot-signing");
  });

  it("maps an encrypt payload into the send body", () => {
    const body = encryptPayloadToSendBody({
      messageId: "mid",
      encryptedContent: "blob",
      encodedEventSignature: "sig",
    });
    assert.deepEqual(body, {
      message_id: "mid",
      encoded_message_create_event: "blob",
      encoded_message_event_signature: "sig",
    });
  });

  it("loads Juicebox realm tokens from token_map", () => {
    const tokens = loadRealmTokens(
      JSON.stringify({
        token_map: [{ key: "AbC", value: { token: "tok" } }],
      })
    );
    assert.equal(tokens.get("abc"), "tok");
    assert.equal(juiceboxConfigJson([{ juicebox_config: { a: 1 }, public_key_version: "1" }]), '{"a":1}');
  });
});

describe("chat PIN rules", () => {
  it("rejects weak PINs the XDK would reject after registration", () => {
    assert.equal(weakPinReason("12"), "must be at least 4 characters");
    assert.equal(weakPinReason("0000"), "must not be a single repeated character");
    assert.equal(weakPinReason("1234"), "must not be a sequential run of digits");
    assert.equal(weakPinReason("4321"), "must not be a sequential run of digits");
    assert.equal(weakPinReason("2580"), null);
  });
});

describe("chat poller internals", () => {
  it("watches allowFrom under allowlist and inbox peers otherwise", () => {
    const { watchList } = _internals;
    assert.deepEqual(
      watchList({ dmPolicy: "allowlist", allowFrom: ["10", "20"] }, "1", ["1-99"]),
      ["10", "20"]
    );
    assert.deepEqual(watchList({ dmPolicy: "allowlist", allowFrom: [] }, "1", ["1-99"]), []);
    const open = watchList({ dmPolicy: "open", allowFrom: [] }, "1", ["1-99", "gXX"]);
    assert.deepEqual(open, ["99"]);
  });

  it("collects encoded events plus meta key-change blobs", () => {
    const { collectEncoded } = _internals;
    const { encoded, list } = collectEncoded({
      data: {
        data: [{ encoded_event: "m1", sender_id: "2" }],
        meta: { conversation_key_events: ["k1"] },
      },
    });
    assert.deepEqual(encoded, ["k1", "m1"]);
    assert.equal(list.length, 1);
  });

  it("orders Chat events by sequence_id, not message_id", () => {
    const { eventIdOf } = _internals;
    assert.equal(
      eventIdOf({ id: "uuid-zzz", sequence_id: "10" }, { id: "uuid-zzz" }),
      "10"
    );
    assert.equal(eventIdOf({ id: "only-msg" }, { id: "only-msg" }), "only-msg");
  });
});

describe("classic isolation", () => {
  it("does not statically import the Chat transport from channel.js", () => {
    const src = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../src/channel.js"),
      "utf8"
    );
    assert.equal(src.includes('from "./chat-transport.js"'), false);
    assert.equal(src.includes('import("./chat-transport.js")'), true);
  });
});
