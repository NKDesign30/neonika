import assert from "node:assert/strict";
import { test } from "node:test";

import {
  NEON_GATEWAY_DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP,
  createNeonPreauthConnectionBudget,
  resolveNeonPreauthMaxConnectionsPerIp
} from "../src/index.js";

test("acquire caps at the per-IP limit and release frees a slot", () => {
  const budget = createNeonPreauthConnectionBudget(2);
  assert.equal(budget.acquire("ip-a"), true);
  assert.equal(budget.acquire("ip-a"), true);
  assert.equal(budget.acquire("ip-a"), false); // capped
  assert.equal(budget.activeCount("ip-a"), 2);
  budget.release("ip-a");
  assert.equal(budget.activeCount("ip-a"), 1);
  assert.equal(budget.acquire("ip-a"), true); // freed slot is reusable
});

test("budgets are tracked independently per IP", () => {
  const budget = createNeonPreauthConnectionBudget(1);
  assert.equal(budget.acquire("ip-a"), true);
  assert.equal(budget.acquire("ip-b"), true); // a different IP is unaffected
  assert.equal(budget.acquire("ip-a"), false);
});

test("release never underflows and an extra release stays at zero", () => {
  const budget = createNeonPreauthConnectionBudget(2);
  budget.release("ip-x"); // no throw when nothing is held
  assert.equal(budget.activeCount("ip-x"), 0);
  budget.acquire("ip-x");
  budget.release("ip-x");
  budget.release("ip-x"); // double release does not go negative
  assert.equal(budget.activeCount("ip-x"), 0);
  assert.equal(budget.acquire("ip-x"), true);
});

test("resolveNeonPreauthMaxConnectionsPerIp uses the default and rejects junk", () => {
  assert.equal(resolveNeonPreauthMaxConnectionsPerIp({}), NEON_GATEWAY_DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP);
  assert.equal(resolveNeonPreauthMaxConnectionsPerIp({ NEON_GATEWAY_MAX_PREAUTH_CONNECTIONS_PER_IP: "4" }), 4);
  assert.equal(
    resolveNeonPreauthMaxConnectionsPerIp({ NEON_GATEWAY_MAX_PREAUTH_CONNECTIONS_PER_IP: "0" }),
    NEON_GATEWAY_DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP
  );
  assert.equal(
    resolveNeonPreauthMaxConnectionsPerIp({ NEON_GATEWAY_MAX_PREAUTH_CONNECTIONS_PER_IP: "abc" }),
    NEON_GATEWAY_DEFAULT_MAX_PREAUTH_CONNECTIONS_PER_IP
  );
});
