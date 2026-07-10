import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NEON_GATEWAY_DEFAULT_KEEPALIVE_INTERVAL_MS,
  resolveNeonGatewayKeepaliveIntervalMs
} from "../src/index.js";

test("resolveNeonGatewayKeepaliveIntervalMs uses the default and rejects junk", () => {
  assert.equal(resolveNeonGatewayKeepaliveIntervalMs({}), NEON_GATEWAY_DEFAULT_KEEPALIVE_INTERVAL_MS);
  assert.equal(resolveNeonGatewayKeepaliveIntervalMs({ NEON_GATEWAY_KEEPALIVE_INTERVAL_MS: "5000" }), 5000);
  assert.equal(
    resolveNeonGatewayKeepaliveIntervalMs({ NEON_GATEWAY_KEEPALIVE_INTERVAL_MS: "0" }),
    NEON_GATEWAY_DEFAULT_KEEPALIVE_INTERVAL_MS
  );
  assert.equal(
    resolveNeonGatewayKeepaliveIntervalMs({ NEON_GATEWAY_KEEPALIVE_INTERVAL_MS: "nope" }),
    NEON_GATEWAY_DEFAULT_KEEPALIVE_INTERVAL_MS
  );
});
