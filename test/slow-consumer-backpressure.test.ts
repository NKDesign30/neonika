import assert from "node:assert/strict";
import { test } from "node:test";

import { isNeonGatewaySlowConsumer } from "../src/index.js";

test("isNeonGatewaySlowConsumer uses the default ceiling for a single argument", () => {
  assert.equal(isNeonGatewaySlowConsumer(0), false);
  assert.equal(isNeonGatewaySlowConsumer(50_000_000), true); // far above the 4 MiB default
});

test("isNeonGatewaySlowConsumer honors an explicit ceiling at the boundary", () => {
  assert.equal(isNeonGatewaySlowConsumer(10, 8), true);
  assert.equal(isNeonGatewaySlowConsumer(8, 8), false); // exactly at the limit is allowed
  assert.equal(isNeonGatewaySlowConsumer(7, 8), false);
});
