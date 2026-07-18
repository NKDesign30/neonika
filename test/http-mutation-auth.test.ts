import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  authorizeNeonHttpMutation,
  NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV
} from "../src/index.js";

describe("Neonika HTTP mutation auth", () => {
  it("allows loopback mutations without a configured token for local dashboard compatibility", () => {
    const decision = authorizeNeonHttpMutation({
      env: {},
      headers: {},
      remoteAddress: "127.0.0.1"
    });

    assert.equal(decision.state, "authorized");
    assert.equal(decision.mode, "loopback-compat");
  });

  it("requires a token for non-loopback mutations when no compatibility token is configured", () => {
    const decision = authorizeNeonHttpMutation({
      env: {},
      headers: {},
      remoteAddress: "192.168.1.20"
    });

    assert.equal(decision.state, "auth-required");
    assert.equal(decision.statusCode, 401);
    assert.equal(decision.error, "neon-http-mutation-auth-required");
  });

  it("requires a configured token even from loopback once the token gate is set", () => {
    const env = {
      [NEON_GATEWAY_HTTP_MUTATION_TOKEN_ENV]: "mutation-token"
    };

    const missing = authorizeNeonHttpMutation({
      env,
      headers: {},
      remoteAddress: "127.0.0.1"
    });
    const wrong = authorizeNeonHttpMutation({
      env,
      headers: { authorization: "Bearer wrong-token" },
      remoteAddress: "127.0.0.1"
    });
    const bearer = authorizeNeonHttpMutation({
      env,
      headers: { authorization: "Bearer mutation-token" },
      remoteAddress: "127.0.0.1"
    });
    const explicitHeader = authorizeNeonHttpMutation({
      env,
      headers: { "x-neon-gateway-token": "mutation-token" },
      remoteAddress: "192.168.1.20"
    });

    assert.equal(missing.state, "auth-required");
    assert.equal(wrong.state, "auth-denied");
    assert.equal(wrong.statusCode, 403);
    assert.equal(bearer.state, "authorized");
    assert.equal(bearer.mode, "configured-token");
    assert.equal(explicitHeader.state, "authorized");
    assert.equal(explicitHeader.mode, "configured-token");
  });
});
