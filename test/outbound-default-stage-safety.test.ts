import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  createNeonCanaryOutboundSender,
  evaluateNeonCanaryLivePreconditions,
  type INeonDeliveryQueueTarget,
  type INeonOutboundTransport
} from "../src/index.js";

/**
 * `primary` became the stage an unconfigured install resolves to, and every reader —
 * including the sender — now shares that fallback. The stage condition therefore
 * passes on a fresh install where it used to fail.
 *
 * This suite pins the consequence that matters: the stage was never the only lock.
 * An install that states nothing must still refuse to send, because approval, the
 * enabled flag and a transport are each independently required.
 */
const target: INeonDeliveryQueueTarget = {
  channel: "discord",
  accountId: "local",
  channelId: "channel-default-stage"
};

function createRecordingTransport(): {
  readonly transport: INeonOutboundTransport;
  readonly sent: string[];
} {
  const sent: string[] = [];
  return {
    sent,
    transport: {
      async postMessage(_target: INeonDeliveryQueueTarget, body: string) {
        sent.push(body);
        return { messageId: "msg-should-not-happen" };
      }
    }
  };
}

describe("Outbound safety on the default stage", () => {
  it("reports the stage as outbound-capable when nothing is stated", () => {
    const preconditions = evaluateNeonCanaryLivePreconditions({});

    assert.equal(preconditions.stageAllowsOutbound, true);
    assert.equal(preconditions.stageIsCanary, false);
  });

  it("is still not ready to send, because approval and arming are missing", () => {
    const preconditions = evaluateNeonCanaryLivePreconditions({});

    assert.equal(preconditions.ready, false);
    assert.equal(preconditions.canaryApproved, false);
    assert.equal(preconditions.outboundEnabled, false);
    assert.equal(preconditions.tokenPresent, false);
  });

  it("refuses to send on an empty env even with a transport attached", async () => {
    const { transport, sent } = createRecordingTransport();
    const sender = createNeonCanaryOutboundSender({ env: {}, transport });

    const result = await sender.sendText(target, "must not leave the process");

    assert.equal(result.outboundSent, false);
    assert.deepEqual(sent, []);
  });

  it("refuses to send when armed but not approved", async () => {
    const { transport, sent } = createRecordingTransport();
    const sender = createNeonCanaryOutboundSender({
      env: {
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
        NEON_CUTOVER_CANARY_CHANNELS: target.channelId
      },
      transport
    });

    const result = await sender.sendText(target, "must not leave the process");

    assert.equal(result.outboundSent, false);
    assert.deepEqual(sent, []);
  });

  it("refuses to send when approved and armed but no transport exists", async () => {
    const sender = createNeonCanaryOutboundSender({
      env: {
        NEON_CUTOVER_CANARY_APPROVED: "ready",
        NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
        NEON_CUTOVER_CANARY_CHANNELS: target.channelId
      }
    });

    const result = await sender.sendText(target, "must not leave the process");

    assert.equal(result.outboundSent, false);
  });

  it("still suppresses on the explicitly non-outbound stages", async () => {
    for (const stage of ["shadow", "mirror", "retire"] as const) {
      const { transport, sent } = createRecordingTransport();
      const sender = createNeonCanaryOutboundSender({
        env: {
          NEON_CUTOVER_STAGE: stage,
          NEON_CUTOVER_CANARY_APPROVED: "ready",
          NEON_CUTOVER_OUTBOUND_ENABLED: "ready",
          NEON_CUTOVER_CANARY_CHANNELS: target.channelId
        },
        transport
      });

      const result = await sender.sendText(target, "must not leave the process");

      assert.equal(result.outboundSent, false, `stage ${stage} must stay suppressed`);
      assert.deepEqual(sent, [], `stage ${stage} must not reach the transport`);
    }
  });
});
