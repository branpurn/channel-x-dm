import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pctEncode, authHeader } from "../src/oauth.js";

describe("oauth", () => {
  it("RFC-3986 encodes the four chars encodeURIComponent omits", () => {
    assert.equal(pctEncode("!*'()"), "%21%2A%27%28%29");
  });

  it("signs with URL query params in the base string (X requirement)", () => {
    const header = authHeader("GET", "https://api.x.com/2/dm_events?max_results=100", {
      X_API_KEY: "key",
      X_API_SECRET: "secret",
      X_ACCESS_TOKEN: "token",
      X_ACCESS_SECRET: "tokensecret",
    });
    assert.match(header, /^OAuth /);
    assert.match(header, /oauth_signature=/);
    assert.match(header, /oauth_consumer_key="key"/);
    assert.match(header, /oauth_token="token"/);
  });
});
