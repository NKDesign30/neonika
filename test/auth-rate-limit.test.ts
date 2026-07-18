import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  NEON_GATEWAY_DEFAULT_AUTH_MAX_ATTEMPTS,
  NEON_GATEWAY_DEFAULT_AUTH_WINDOW_MS,
  createNeonAuthRateLimiter,
  resolveNeonAuthRateLimitConfig
} from "../src/index.js";

describe("Neon Gateway auth-failure rate limiter (Z305)", () => {
  it("exempts loopback and unknown addresses (local clients never lock out)", () => {
    const limiter = createNeonAuthRateLimiter({ maxAttempts: 2, windowMs: 1000, lockoutMs: 5000 });
    for (let i = 0; i < 10; i += 1) {
      limiter.recordFailure("127.0.0.1", 1000 + i);
      limiter.recordFailure("::1", 1000 + i);
      limiter.recordFailure("::ffff:127.0.0.1", 1000 + i);
      limiter.recordFailure(undefined, 1000 + i);
    }
    assert.equal(limiter.check("127.0.0.1", 2000).allowed, true);
    assert.equal(limiter.check("::1", 2000).allowed, true);
    assert.equal(limiter.check(undefined, 2000).allowed, true);
    assert.equal(limiter.size(), 0);
  });

  it("locks an IP after maxAttempts failures inside the window", () => {
    const limiter = createNeonAuthRateLimiter({ maxAttempts: 3, windowMs: 10_000, lockoutMs: 60_000 });
    const ip = "203.0.113.5";
    assert.equal(limiter.check(ip, 0).allowed, true);
    limiter.recordFailure(ip, 0);
    limiter.recordFailure(ip, 1);
    assert.equal(limiter.check(ip, 2).allowed, true); // 2 < 3, still allowed
    limiter.recordFailure(ip, 2); // 3rd failure trips the lock
    const decision = limiter.check(ip, 3);
    assert.equal(decision.allowed, false);
    assert.ok(decision.retryAfterMs > 0);
    assert.ok(decision.retryAfterMs <= 60_000);
  });

  it("prunes attempts that fell out of the sliding window", () => {
    const limiter = createNeonAuthRateLimiter({ maxAttempts: 3, windowMs: 1000, lockoutMs: 60_000 });
    const ip = "203.0.113.6";
    limiter.recordFailure(ip, 0);
    limiter.recordFailure(ip, 100);
    // 2000 is > windowMs past the first two -> they prune; only this one stays.
    limiter.recordFailure(ip, 2000);
    assert.equal(limiter.check(ip, 2001).allowed, true);
  });

  it("unlocks after the lockout expires", () => {
    const limiter = createNeonAuthRateLimiter({ maxAttempts: 1, windowMs: 1000, lockoutMs: 5000 });
    const ip = "203.0.113.7";
    limiter.recordFailure(ip, 0); // 1st failure -> locked until 5000
    assert.equal(limiter.check(ip, 100).allowed, false);
    assert.equal(limiter.check(ip, 5001).allowed, true);
  });

  it("reset clears the lock and frees the entry", () => {
    const limiter = createNeonAuthRateLimiter({ maxAttempts: 1, windowMs: 1000, lockoutMs: 5000 });
    const ip = "203.0.113.8";
    limiter.recordFailure(ip, 0);
    assert.equal(limiter.check(ip, 100).allowed, false);
    limiter.reset(ip);
    assert.equal(limiter.check(ip, 100).allowed, true);
    assert.equal(limiter.size(), 0);
  });

  it("resolves config from env with a junk/zero fallback to defaults", () => {
    assert.equal(resolveNeonAuthRateLimitConfig({}).maxAttempts, NEON_GATEWAY_DEFAULT_AUTH_MAX_ATTEMPTS);
    assert.equal(resolveNeonAuthRateLimitConfig({ NEON_GATEWAY_AUTH_MAX_ATTEMPTS: "3" }).maxAttempts, 3);
    assert.equal(
      resolveNeonAuthRateLimitConfig({ NEON_GATEWAY_AUTH_MAX_ATTEMPTS: "nope" }).maxAttempts,
      NEON_GATEWAY_DEFAULT_AUTH_MAX_ATTEMPTS
    );
    assert.equal(
      resolveNeonAuthRateLimitConfig({ NEON_GATEWAY_AUTH_WINDOW_MS: "0" }).windowMs,
      NEON_GATEWAY_DEFAULT_AUTH_WINDOW_MS
    );
  });
});
