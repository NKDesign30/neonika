import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendNeonCronStoreEvent,
  projectNeonCronStoreJobs,
  readNeonCronStoreEvents,
  renderNeonCronDeliveryPreview,
  resolveNeonCronMutation,
  resolveNeonCronStoreGate,
  type INeonCronStoreEvent,
  type INeonCronStoreJob,
  type TNeonCronJobMutation
} from "../src/index.js";

const NOW = 1_750_000_000_000;

function evt(
  over: { readonly id: string; readonly mutation: TNeonCronJobMutation; readonly atMs?: number; readonly schedule?: string; readonly label?: string }
): INeonCronStoreEvent {
  return {
    id: over.id,
    mutation: over.mutation,
    atMs: over.atMs ?? NOW,
    ...(over.schedule !== undefined ? { schedule: over.schedule } : {}),
    ...(over.label !== undefined ? { label: over.label } : {})
  };
}

test("resolveNeonCronStoreGate is default-off and arms on a ready flag", () => {
  assert.equal(resolveNeonCronStoreGate({}).enabled, false);
  assert.equal(resolveNeonCronStoreGate({ NEON_CRON_STORE_ENABLED: "1" }).enabled, true);
});

test("appendNeonCronStoreEvent is blocked and writes nothing when the gate is closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "neon-cron-store-test-"));
  const result = await appendNeonCronStoreEvent(
    root,
    resolveNeonCronStoreGate({}),
    evt({ id: "a", mutation: "add", schedule: "every-15m" })
  );
  assert.equal(result.state, "blocked");
  assert.equal((await readNeonCronStoreEvents(root)).length, 0);
});

test("resolveNeonCronMutation guards add/update/remove existence", () => {
  const jobs: INeonCronStoreJob[] = [
    { id: "x", schedule: "every-15m", label: "X", enabled: true, createdAtMs: NOW, updatedAtMs: NOW }
  ];
  assert.equal(resolveNeonCronMutation(jobs, { id: "x", mutation: "add", atMs: NOW, schedule: "every-1m" }).ok, false);
  assert.equal(resolveNeonCronMutation([], { id: "y", mutation: "add", atMs: NOW }).ok, false);
  assert.equal(resolveNeonCronMutation([], { id: "y", mutation: "add", atMs: NOW, schedule: "every-1m" }).ok, true);
  assert.equal(resolveNeonCronMutation([], { id: "z", mutation: "remove", atMs: NOW }).ok, false);
  assert.equal(resolveNeonCronMutation(jobs, { id: "x", mutation: "disable", atMs: NOW }).ok, true);
});

test("projectNeonCronStoreJobs upserts, toggles, and tombstones", () => {
  const jobs = projectNeonCronStoreJobs([
    evt({ id: "a", mutation: "add", schedule: "every-15m", label: "A" }),
    evt({ id: "b", mutation: "add", schedule: "every-60m", label: "B" }),
    evt({ id: "a", mutation: "disable" }),
    evt({ id: "b", mutation: "remove" })
  ]);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.id, "a");
  assert.equal(jobs[0]?.enabled, false);
  assert.equal(jobs[0]?.schedule, "every-15m");
});

test("projectNeonCronStoreJobs keeps createdAt and advances updatedAt across events", () => {
  const jobs = projectNeonCronStoreJobs([
    evt({ id: "a", mutation: "add", schedule: "every-15m", label: "A", atMs: 100 }),
    evt({ id: "a", mutation: "update", schedule: "every-30m", atMs: 200 })
  ]);
  assert.equal(jobs[0]?.createdAtMs, 100);
  assert.equal(jobs[0]?.updatedAtMs, 200);
  assert.equal(jobs[0]?.schedule, "every-30m");
});

test("armed append + read roundtrips through an isolated store", async () => {
  const root = await mkdtemp(join(tmpdir(), "neon-cron-store-test-"));
  const gate = resolveNeonCronStoreGate({ NEON_CRON_STORE_ENABLED: "1" });
  await appendNeonCronStoreEvent(root, gate, evt({ id: "a", mutation: "add", schedule: "every-15m", label: "A" }));
  await appendNeonCronStoreEvent(root, gate, evt({ id: "a", mutation: "enable", atMs: NOW + 1 }));
  const jobs = projectNeonCronStoreJobs(await readNeonCronStoreEvents(root));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.enabled, true);
});

test("resolveNeonCronMutation redacts a secret-shaped label before it is stored", () => {
  const resolved = resolveNeonCronMutation([], {
    id: "a",
    mutation: "add",
    atMs: NOW,
    schedule: "every-15m",
    label: "deploy sk-livedeadbeef0123456789"
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) {
    assert.doesNotMatch(resolved.event.label ?? "", /sk-livedeadbeef0123456789/);
    assert.match(resolved.event.label ?? "", /\[REDACTED_SECRET\]/);
  }
});

test("resolveNeonCronMutation normalizes a delivery target and rejects an unroutable one", () => {
  const ok = resolveNeonCronMutation([], {
    id: "a",
    mutation: "add",
    atMs: NOW,
    schedule: "every-15m",
    deliveryTarget: { channel: "discord", accountId: "  acct ", to: "  c1 ", chatType: "channel" }
  });
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.event.deliveryTarget, { channel: "discord", accountId: "acct", to: "c1", chatType: "channel" });
  }
  const bad = resolveNeonCronMutation([], {
    id: "b",
    mutation: "add",
    atMs: NOW,
    schedule: "every-15m",
    deliveryTarget: { channel: "carrier-pigeon", to: "x" }
  });
  assert.equal(bad.ok, false);
});

test("projectNeonCronStoreJobs carries the delivery target and preserves it across a label update", () => {
  const target = { channel: "discord", to: "c1", chatType: "channel" } as const;
  const jobs = projectNeonCronStoreJobs([
    { id: "a", mutation: "add", atMs: 100, schedule: "every-15m", label: "A", deliveryTarget: target },
    { id: "a", mutation: "update", atMs: 200, label: "A2" }
  ]);
  assert.deepEqual(jobs[0]?.deliveryTarget, target);
  assert.equal(jobs[0]?.label, "A2");
});

test("renderNeonCronDeliveryPreview describes suppressed targets and is leak-safe", () => {
  const jobs = projectNeonCronStoreJobs([
    {
      id: "with",
      mutation: "add",
      atMs: NOW,
      schedule: "every-60m",
      label: "x",
      deliveryTarget: { channel: "discord", to: "sk-livedeadbeef0123456789", chatType: "channel" }
    },
    { id: "without", mutation: "add", atMs: NOW, schedule: "every-60m", label: "y" }
  ]);
  const preview = renderNeonCronDeliveryPreview(jobs);
  assert.match(preview, /suppressed/);
  assert.match(preview, /without: no delivery target/);
  assert.doesNotMatch(preview, /sk-livedeadbeef0123456789/);
});
